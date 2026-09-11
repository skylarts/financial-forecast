import type { ISODate } from "@/domain";
import {
  closesLotOn,
  isOptionSymbol,
  normalizeSymbol,
  opensLotOn,
  type TransactionType,
} from "@/domain/portfolio";
import type { SplitEvent } from "@/engine/portfolio/performance";
import type { DraftTransaction } from "./importer";

/**
 * Splits the feed knows about that a file is missing.
 *
 * Statement exports are unreliable about splits: Schwab's lists the shares a
 * split added rather than its ratio, Fidelity's omits it, a workplace plan's
 * restates every unit count. Left out, a position bought before a split is
 * carried at its old share count against today's price -- UVXY, held for five
 * days in 2022 and reverse-split four times since, valued at $33,000 inside a
 * $1,000 account.
 *
 * The engine's own answer to a split is a `split` row: it keeps every trade
 * as the statement wrote it (which is also what the duplicate check keys on)
 * and multiplies the lots on the day the shares changed. So this does not
 * restate the imported rows; it works out which split rows the ledger will
 * need once the file lands, and offers them.
 *
 * A split needs a row only if shares were held through it and nothing in the
 * ledger or the file already answers for it. That is the same test the
 * performance engine applies when it decides whether to trust the feed's
 * calendar (see `matchedSplits` in `src/engine/portfolio/performance.ts`),
 * so a row added here is exactly a row that engine would otherwise have found
 * missing.
 */

export interface SplitSuggestion {
  symbol: string;
  date: ISODate;
  /** New shares per old share; below one for a reverse split. */
  ratio: number;
  /** Shares on the books the day before, ledger and file together. */
  sharesBefore: number;
  sharesAfter: number;
}

/** A row as this module needs to see it: the file's drafts and the ledger's
 *  transactions both fit. */
export interface SplitLedgerRow {
  date: ISODate;
  type: TransactionType;
  symbol: string | null;
  quantity: number;
}

/**
 * How far a broker may date a split from the feed's day, and how far a
 * recorded ratio may sit from the feed's, before they stop being the same
 * event. Mirrors the tolerances the performance engine matches on.
 */
const MATCH_DAYS = 7;
const RATIO_TOLERANCE = 0.01;

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Signed shares a row adds to a position: opening long or covering short is
 *  positive, closing long or opening short negative; splits multiply. */
function applyRow(held: number, row: SplitLedgerRow): number {
  if (row.type === "split") return held * (row.quantity > 0 ? row.quantity : 1);
  const opens = opensLotOn(row.type);
  const closes = closesLotOn(row.type);
  if (opens === "long" || closes === "short") return held + row.quantity;
  if (closes === "long" || opens === "short") return held - row.quantity;
  return held;
}

/**
 * The split rows `fileRows` will leave the ledger needing, given what the
 * target accounts already hold and what the feed's calendar says.
 *
 * `feedSplits` is keyed by canonical symbol and holds only symbols the feed
 * actually answered for; a symbol absent from it is unknown, not split-free,
 * and gets no suggestion either way.
 */
export function suggestSplitRows(
  fileRows: readonly SplitLedgerRow[],
  ledgerRows: readonly SplitLedgerRow[],
  feedSplits: ReadonlyMap<string, readonly SplitEvent[]>,
): SplitSuggestion[] {
  const bySymbol = new Map<string, SplitLedgerRow[]>();
  for (const row of [...ledgerRows, ...fileRows]) {
    if (row.symbol === null) continue;
    const symbol = normalizeSymbol(row.symbol);
    // A contract is never split; its underlying's calendar is not its own.
    if (isOptionSymbol(symbol)) continue;
    const rows = bySymbol.get(symbol);
    if (rows) rows.push(row);
    else bySymbol.set(symbol, [row]);
  }

  const suggestions: SplitSuggestion[] = [];
  for (const [symbol, rows] of bySymbol) {
    const events = feedSplits.get(symbol);
    if (!events || events.length === 0) continue;
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const recorded = rows.filter((r) => r.type === "split" || r.type === "spinoff");

    for (const event of events) {
      // Already on the books, as a split row or a spinoff that explains it.
      const answered = recorded.some(
        (r) =>
          daysBetween(r.date, event.date) <= MATCH_DAYS &&
          (r.type === "spinoff" || Math.abs(r.quantity / event.ratio - 1) <= RATIO_TOLERANCE),
      );
      if (answered) continue;

      let held = 0;
      for (const row of rows) {
        if (row.date >= event.date) break;
        held = applyRow(held, row);
      }
      // Nothing held through it: the feed's event stands on its own and the
      // engine needs no row. Under a thousandth of a share is rounding.
      if (Math.abs(held) < 1e-3) continue;

      suggestions.push({
        symbol,
        date: event.date,
        ratio: event.ratio,
        sharesBefore: held,
        sharesAfter: held * event.ratio,
      });
      // A later split is measured after this one lands, as it will in the
      // ledger once both rows are written.
      rows.push({ date: event.date, type: "split", symbol, quantity: event.ratio });
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
  }

  return suggestions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.symbol < b.symbol ? -1 : 1));
}

/** Fingerprint a feed-sourced split row carries, so a re-import recognises it. */
export function feedSplitHash(symbol: string, date: ISODate): string {
  return `feed-split:${symbol}:${date}`;
}

/** The ledger row a suggestion becomes. */
export function splitDraft(suggestion: SplitSuggestion): DraftTransaction {
  return {
    date: suggestion.date,
    type: "split",
    symbol: suggestion.symbol,
    quantity: suggestion.ratio,
    price: 0,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "Split added from the price feed's calendar at import",
    sourceHash: feedSplitHash(suggestion.symbol, suggestion.date),
  };
}
