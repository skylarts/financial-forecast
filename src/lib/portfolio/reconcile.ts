import type { Id } from "@/domain";
import { normalizeSymbol, type PositionSide } from "@/domain/portfolio";
import type { Holding } from "@/engine/portfolio/metrics";
import { parseDelimited, parseNumber, type ParsedTable } from "./importer";

/** One position as reported by a real brokerage holdings statement. */
export interface StatementPosition {
  symbol: string;
  /** Negative quantities are read as a short position, the way statements print them. */
  quantity: number;
  side: PositionSide;
  /** Total cost basis when the statement gives one. */
  costBasis: number | null;
}

export type ReconcileStatus =
  /** Ledger and statement agree on the share count. */
  | "match"
  /** Statement holds more than the ledger — purchases are missing. */
  | "missing_buys"
  /** Ledger holds more than the statement — sales are missing. */
  | "missing_sells"
  /** The statement doesn't list a position the ledger thinks is open. */
  | "not_held"
  /** The ledger has no history at all for a position the statement holds. */
  | "unknown_position";

export interface ReconcileRow {
  symbol: string;
  side: PositionSide;
  /** Shares the ledger derives from the transaction history. */
  ledgerQuantity: number;
  /** Shares the statement reports. */
  statementQuantity: number;
  /** statement − ledger. Positive means the ledger is short some purchases. */
  difference: number;
  status: ReconcileStatus;
  /** Cost basis the statement gave for the whole position, if any. */
  statementCostBasis: number | null;
  ledgerCostBasis: number;
  /** What the user should do about it, in plain language. */
  advice: string;
}

export interface ReconcileResult {
  rows: ReconcileRow[];
  matched: number;
  /** Rows needing attention, i.e. everything that isn't a clean match. */
  discrepancies: number;
}

/** Share counts within this are treated as equal, absorbing fractional dust. */
const TOLERANCE = 1e-4;

const SYMBOL_PATTERNS = [/^symbol$/i, /^ticker$/i, /security/i, /symbol/i, /ticker/i, /^name$/i];
const QUANTITY_PATTERNS = [/^quantity$/i, /^shares$/i, /^qty$/i, /quantity/i, /shares/i, /units/i];
const BASIS_PATTERNS = [/total\s*cost/i, /cost\s*basis/i, /^basis$/i, /cost/i];

function findColumn(headers: readonly string[], patterns: readonly RegExp[]): number | null {
  for (const pattern of patterns) {
    const index = headers.findIndex((h) => pattern.test(h));
    if (index !== -1) return index;
  }
  return null;
}

/**
 * Reads a pasted holdings statement into positions.
 *
 * Deliberately more forgiving than the transaction importer: a holdings list is
 * often copied by hand or trimmed to two columns, so a bare "AAPL 100" per line
 * is accepted alongside a full CSV export.
 */
export function parseHoldingsStatement(text: string): StatementPosition[] {
  const table: ParsedTable = parseDelimited(text);
  const positions: StatementPosition[] = [];

  const symbolIndex = findColumn(table.headers, SYMBOL_PATTERNS);
  const quantityIndex = findColumn(table.headers, QUANTITY_PATTERNS);
  const basisIndex = findColumn(table.headers, BASIS_PATTERNS);

  const rows =
    symbolIndex === null || quantityIndex === null
      ? // No recognizable header: treat every line as "<symbol> <quantity>",
        // including the line parseDelimited guessed was a header.
        [table.headers, ...table.rows].map((cells) =>
          cells.length > 1 ? cells : cells[0]?.split(/\s+/) ?? [],
        )
      : table.rows;

  const symbolAt = symbolIndex ?? 0;
  const quantityAt = quantityIndex ?? 1;

  for (const cells of rows) {
    const rawSymbol = (cells[symbolAt] ?? "").trim();
    if (!rawSymbol || !/^[A-Za-z][A-Za-z0-9.\-]{0,11}$/.test(rawSymbol)) continue;
    const quantity = parseNumber(cells[quantityAt] ?? "");
    if (quantity === null || quantity === 0) continue;

    positions.push({
      symbol: normalizeSymbol(rawSymbol),
      quantity: Math.abs(quantity),
      side: quantity < 0 ? "short" : "long",
      costBasis: basisIndex === null ? null : parseNumber(cells[basisIndex] ?? ""),
    });
  }
  return positions;
}

function adviceFor(status: ReconcileStatus, difference: number, symbol: string): string {
  const amount = Math.abs(difference).toLocaleString(undefined, { maximumFractionDigits: 4 });
  switch (status) {
    case "match":
      return "Ledger agrees with the statement.";
    case "missing_buys":
      return `The statement holds ${amount} more shares of ${symbol} than your transactions account for — a purchase is missing.`;
    case "missing_sells":
      return `Your transactions leave ${amount} more shares of ${symbol} than the statement holds — a sale is missing.`;
    case "not_held":
      return `Your transactions still show ${amount} shares of ${symbol}, but the statement doesn't list it — the closing sale is missing.`;
    case "unknown_position":
      return `The statement holds ${amount} shares of ${symbol} with no transaction history at all — its whole purchase history is missing.`;
  }
}

/**
 * Diffs a holdings statement against the positions the ledger derives.
 *
 * This is the counterpart to the oversell warning, which can only ever catch a
 * gap at the moment you sell. Comparing against what you actually hold today
 * finds the gaps in positions you've never sold, which is most of them.
 *
 * Scoped to one account: share counts are only comparable against the statement
 * they came from, and summing a symbol across accounts would hide a gap in one
 * account behind a surplus in another.
 */
export function reconcileHoldings(
  statement: readonly StatementPosition[],
  holdings: readonly Holding[],
  accountId: Id,
): ReconcileResult {
  const ledger = new Map<string, Holding>();
  for (const holding of holdings) {
    if (holding.accountId === accountId) ledger.set(`${holding.symbol}::${holding.side}`, holding);
  }

  const rows: ReconcileRow[] = [];
  const seen = new Set<string>();

  for (const position of statement) {
    const key = `${position.symbol}::${position.side}`;
    seen.add(key);
    const holding = ledger.get(key);
    const ledgerQuantity = holding?.quantity ?? 0;
    const difference = position.quantity - ledgerQuantity;

    let status: ReconcileStatus;
    if (Math.abs(difference) <= TOLERANCE) status = "match";
    else if (ledgerQuantity === 0) status = "unknown_position";
    else status = difference > 0 ? "missing_buys" : "missing_sells";

    rows.push({
      symbol: position.symbol,
      side: position.side,
      ledgerQuantity,
      statementQuantity: position.quantity,
      difference,
      status,
      statementCostBasis: position.costBasis,
      ledgerCostBasis: holding?.costBasis ?? 0,
      advice: adviceFor(status, difference, position.symbol),
    });
  }

  // Positions the ledger believes are open but the statement never mentions.
  for (const [key, holding] of ledger) {
    if (seen.has(key)) continue;
    rows.push({
      symbol: holding.symbol,
      side: holding.side,
      ledgerQuantity: holding.quantity,
      statementQuantity: 0,
      difference: -holding.quantity,
      status: "not_held",
      statementCostBasis: null,
      ledgerCostBasis: holding.costBasis,
      advice: adviceFor("not_held", -holding.quantity, holding.symbol),
    });
  }

  // Discrepancies first, then biggest gaps -- the point of the screen is what's
  // wrong, not an alphabetical inventory of what's right.
  rows.sort((a, b) => {
    if ((a.status === "match") !== (b.status === "match")) return a.status === "match" ? 1 : -1;
    return Math.abs(b.difference) - Math.abs(a.difference);
  });

  const matched = rows.filter((row) => row.status === "match").length;
  return { rows, matched, discrepancies: rows.length - matched };
}
