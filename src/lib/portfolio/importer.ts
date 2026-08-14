import type { ISODate } from "@/domain";
import {
  normalizeSymbol,
  transactionTypeSchema,
  TRANSACTION_TYPE_LABELS,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** Column index in the source table for each field, or null if unmapped. */
export interface ColumnMapping {
  date: number | null;
  type: number | null;
  symbol: number | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number | null;
  lotId: number | null;
  acquiredDate: number | null;
  /** For a spinoff/exchange row: the new symbol the distribution creates. */
  spinoffSymbol: number | null;
  /** For a spinoff/exchange row: new shares of spinoffSymbol per one old share. */
  spinoffShareRatio: number | null;
  /** For a spinoff/exchange row: fraction of basis staying with `symbol`, 0-1. */
  spinoffBasisRetained: number | null;
  note: number | null;
}

export type ImportField = keyof ColumnMapping;

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  date: "Date",
  type: "Action / type",
  symbol: "Symbol",
  quantity: "Quantity",
  price: "Price",
  amount: "Amount",
  fees: "Fees",
  lotId: "Lot ID",
  acquiredDate: "Date acquired",
  spinoffSymbol: "Spinoff: new symbol",
  spinoffShareRatio: "Spinoff: share ratio",
  spinoffBasisRetained: "Spinoff: basis retained",
  note: "Description",
};

export type DraftTransaction = Omit<Transaction, "id" | "accountId" | "importBatchId">;

export interface ImportRow {
  raw: string[];
  draft: DraftTransaction;
  /** Non-fatal notes; a row with issues still imports unless `skip` is set. */
  issues: string[];
  /** True when the row could not be understood well enough to import. */
  skip: boolean;
  /** True when an identical row is already in the ledger. */
  duplicate: boolean;
}

/** Splits one CSV line, honoring quoted fields and doubled escape quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      out.push(field.trim());
      field = "";
    } else field += char;
  }
  out.push(field.trim());
  return out;
}

function splitMarkdownRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const MARKDOWN_DIVIDER = /^[\s|:-]+$/;

/**
 * Reads a pasted or uploaded statement into a header row plus data rows,
 * accepting both CSV and markdown tables.
 *
 * The header is found by scanning rather than assumed to be line one:
 * brokerage exports routinely open with a title, an account number, and a
 * blank line before the real columns start, and every one of those preamble
 * lines would otherwise be mistaken for the header.
 */
export function parseDelimited(text: string): ParsedTable {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const isMarkdown = lines.filter((line) => line.includes("|")).length > lines.length / 2;
  const split = isMarkdown ? splitMarkdownRow : splitCsvLine;
  const candidates = lines.filter((line) => !(isMarkdown && MARKDOWN_DIVIDER.test(line)));

  let headerIndex = 0;
  let bestScore = -1;
  const limit = Math.min(candidates.length, 15);
  for (let i = 0; i < limit; i += 1) {
    const cells = split(candidates[i]);
    if (cells.length < 2) continue;
    // The real header is the line whose cells look most like field names:
    // several non-empty, mostly non-numeric columns.
    const filled = cells.filter((c) => c.length > 0).length;
    const numeric = cells.filter((c) => c.length > 0 && /^[-$(]?[\d,.]+\)?$/.test(c)).length;
    const score = filled - numeric * 3;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = i;
    }
  }

  const headers = split(candidates[headerIndex]);
  const rows = candidates
    .slice(headerIndex + 1)
    .map(split)
    .filter((cells) => cells.some((c) => c.length > 0));
  return { headers, rows };
}

const FIELD_PATTERNS: Record<ImportField, RegExp[]> = {
  // Ordered by specificity: "date acquired" must not be claimed by /date/.
  acquiredDate: [/date\s*acquired/i, /acquired/i, /open(ed)?\s*date/i],
  date: [/trade\s*date/i, /run\s*date/i, /settle(ment)?\s*date/i, /^date$/i, /date/i],
  type: [/^action$/i, /^type$/i, /transaction\s*type/i, /activity/i, /action/i],
  symbol: [/^symbol$/i, /^ticker$/i, /security\s*(id|symbol)/i, /symbol/i, /ticker/i],
  quantity: [/^quantity$/i, /^shares$/i, /^qty$/i, /quantity/i, /shares/i, /units/i],
  price: [/price\s*per\s*share/i, /share\s*price/i, /^price$/i, /price/i],
  fees: [/fees?\s*(and|&)\s*comm/i, /commission/i, /^fees?$/i, /fee/i],
  amount: [/net\s*amount/i, /^amount$/i, /proceeds/i, /total/i, /principal/i, /amount/i],
  lotId: [/lot\s*(id|number|#)/i, /^lot$/i],
  spinoffSymbol: [/spinoff.*symbol/i, /new\s*symbol/i],
  spinoffShareRatio: [/spinoff.*ratio/i, /share\s*ratio/i],
  spinoffBasisRetained: [/basis\s*retained/i, /spinoff.*basis/i],
  note: [/description/i, /memo/i, /^note$/i],
};

/**
 * Best-guess column mapping for a header row. Fields are resolved most-specific
 * first and each column is claimed at most once, so a file carrying both
 * "Date" and "Date acquired" doesn't map them to the same field.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    date: null,
    type: null,
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    fees: null,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: null,
  };
  const claimed = new Set<number>();

  // acquiredDate before date, and fees before amount, so the narrower pattern
  // gets first claim on a column the broader one would also match.
  const order: ImportField[] = [
    "acquiredDate",
    "date",
    "type",
    "symbol",
    "quantity",
    "price",
    "fees",
    "amount",
    "lotId",
    "spinoffSymbol",
    "spinoffShareRatio",
    "spinoffBasisRetained",
    "note",
  ];

  for (const field of order) {
    for (const pattern of FIELD_PATTERNS[field]) {
      const index = headers.findIndex((h, i) => !claimed.has(i) && pattern.test(h));
      if (index !== -1) {
        mapping[field] = index;
        claimed.add(index);
        break;
      }
    }
  }
  return mapping;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Normalizes the date formats brokerages actually emit into YYYY-MM-DD. */
export function parseDate(raw: string): ISODate | null {
  const text = raw.trim().replace(/\s+as\s+of.*$/i, "");
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const named = text.match(/^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s-]*(\d{4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    return month ? `${named[3]}-${month}-${named[1].padStart(2, "0")}` : null;
  }

  const monthFirst = text.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    return month ? `${monthFirst[3]}-${month}-${monthFirst[2].padStart(2, "0")}` : null;
  }
  return null;
}

/** Reads a money or share figure, tolerating $, commas, and (parenthesized) negatives. */
export function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text || /^(n\/?a|-{1,2}|—)$/i.test(text)) return null;
  const negative = /^\(.*\)$/.test(text) || text.includes("-");
  const digits = text.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

const TYPE_PATTERNS: [RegExp, TransactionType][] = [
  [/reinvest|drip/i, "reinvest"],
  [/dividend|cap(ital)?\s*gain|distribution\s*received/i, "dividend"],
  [/interest/i, "interest"],
  // Ahead of the plain "split" pattern below: "spin-off" wording never carries
  // a ratio simple enough for that type to replay correctly on its own.
  [/spin[\s-]?off|stock\s*merger|reorganiz/i, "spinoff"],
  [/split/i, "split"],
  [/(transfer|journal|received).*(in|received)|in\s*bound/i, "transfer_in"],
  [/(transfer|journal|delivered).*(out|delivered)/i, "transfer_out"],
  // Short wording must be tested before plain buy/sell, since every one of
  // these strings also contains the word "buy" or "sold".
  [/(sell|sold|sale)\s*(-|_)?\s*short|short\s*(sell|sale)/i, "short_sell"],
  [/(buy|bought)\s*(-|_)?\s*to\s*cover|cover\s*short|short\s*cover/i, "buy_to_cover"],
  // Option lifecycle wording, ahead of plain buy/sell: a statement line reading
  // "Assigned - Sold to close" contains "sold" and would otherwise import as an
  // ordinary sale, double-counting the premium the assignment already absorbed.
  [/expir/i, "option_expire"],
  [/assign/i, "option_assign"],
  [/exercis/i, "option_exercise"],
  [/buy|bought|purchase|you\s*bought/i, "buy"],
  [/sell|sold|redemption|redeem|you\s*sold/i, "sell"],
  [/fee|commission|charge/i, "fee"],
  [/deposit|contribution|funds\s*received/i, "cash_deposit"],
  [/withdraw|distribution|funds\s*paid/i, "cash_withdrawal"],
];

/** Maps a statement's action wording onto a ledger transaction type. */
export function inferType(raw: string): TransactionType | null {
  const text = raw.trim();
  if (!text) return null;
  const exact = transactionTypeSchema.safeParse(text.toLowerCase().replace(/[\s-]+/g, "_"));
  if (exact.success) return exact.data;
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * Transfer wording that names no direction -- "Transfer (Securities)",
 * "Transfer (Cash/ACAT)", a bare "ACAT". The patterns above can only match
 * wording that says in or out, so these fall through untyped and the row is
 * dropped. That is how the outbound half of a custodian move goes missing
 * while the inbound half lands: the shares appear from nowhere, and whatever
 * closes them later is booked against no cost basis at all.
 *
 * The direction is still recoverable from the row itself -- shares leaving
 * carry a negative quantity, cash arriving a positive amount -- so callers
 * resolve it by sign rather than discarding the row.
 */
export function isDirectionlessTransfer(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (!/transfer|journal|acat/i.test(text)) return false;
  return inferType(text) === null;
}

/** Stable fingerprint of a source row, used to skip rows already imported. */
export function hashRow(cells: readonly string[]): string {
  const text = cells.join("");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function cell(row: readonly string[], index: number | null): string {
  return index === null ? "" : (row[index] ?? "");
}

/**
 * Turns mapped rows into transaction drafts, flagging anything ambiguous
 * rather than guessing silently. A row missing a usable date or type is
 * skipped, since importing it would put an untraceable entry in the ledger.
 */
export function buildImportRows(
  table: ParsedTable,
  mapping: ColumnMapping,
  existing: readonly Transaction[] = [],
): ImportRow[] {
  const seen = new Set(existing.map((tx) => tx.sourceHash).filter((h): h is string => h !== null));

  return table.rows.map((raw) => {
    const issues: string[] = [];
    const date = parseDate(cell(raw, mapping.date));
    const quantity = parseNumber(cell(raw, mapping.quantity));
    const price = parseNumber(cell(raw, mapping.price));
    const amount = parseNumber(cell(raw, mapping.amount));
    const fees = parseNumber(cell(raw, mapping.fees));
    const symbolRaw = cell(raw, mapping.symbol).trim();
    const spinoffSymbolRaw = cell(raw, mapping.spinoffSymbol).trim();
    const spinoffShareRatio = parseNumber(cell(raw, mapping.spinoffShareRatio));
    const spinoffBasisRetained = parseNumber(cell(raw, mapping.spinoffBasisRetained));
    const note = cell(raw, mapping.note).trim();

    // The action column is the primary signal, but many exports fold the
    // action into a free-text description instead, so fall back to that.
    const action = cell(raw, mapping.type);
    let type = inferType(action) ?? inferType(note);
    // A transfer that never says which way it went still carries its direction
    // in the numbers: shares leaving are negative, cash arriving is positive.
    // Reading it here keeps both halves of a custodian move in the ledger --
    // dropping one half is what leaves shares with no cost basis behind them.
    if (!type && (isDirectionlessTransfer(action) || isDirectionlessTransfer(note))) {
      if (quantity !== null && quantity !== 0) {
        type = quantity < 0 ? "transfer_out" : "transfer_in";
      } else if (amount !== null && amount !== 0) {
        type = amount < 0 ? "cash_withdrawal" : "cash_deposit";
      }
      if (type) {
        issues.push(`Transfer direction not stated; read as a ${TRANSACTION_TYPE_LABELS[type].toLowerCase()} from the sign.`);
      }
    }
    if (!type && quantity !== null && amount !== null) {
      type = amount < 0 ? "buy" : "sell";
      issues.push(`Type not stated; read as a ${type} from the amount's sign.`);
    }

    if (!date) issues.push("No date could be read from this row.");
    if (!type) issues.push("Could not tell what kind of transaction this is.");

    const needsSymbol = type !== null && type !== "cash_deposit" && type !== "cash_withdrawal" && type !== "interest" && type !== "fee";
    if (needsSymbol && !symbolRaw) issues.push("No symbol on a row that needs one.");

    // A spinoff drives the lot engine's pro-rata basis split, so a row
    // missing any of these three would silently do nothing on import rather
    // than raise the position it's meant to create -- skip it instead.
    if (type === "spinoff") {
      if (!spinoffSymbolRaw) issues.push("Spinoff row has no new symbol.");
      if (spinoffShareRatio === null || spinoffShareRatio <= 0) issues.push("Spinoff row has no positive share ratio.");
      if (spinoffBasisRetained === null || spinoffBasisRetained < 0 || spinoffBasisRetained > 1) {
        issues.push("Spinoff row's basis retained must be between 0 and 1.");
      }
    }

    const sourceHash = hashRow(raw);
    const draft: DraftTransaction = {
      date: date ?? "",
      type: type ?? "buy",
      symbol: symbolRaw ? normalizeSymbol(symbolRaw) : null,
      quantity: quantity === null ? 0 : Math.abs(quantity),
      price: price === null ? 0 : Math.abs(price),
      amount: amount === null ? null : Math.abs(amount),
      fees: fees === null ? 0 : Math.abs(fees),
      lotId: cell(raw, mapping.lotId).trim() || null,
      acquiredDate: parseDate(cell(raw, mapping.acquiredDate)),
      spinoffSymbol: spinoffSymbolRaw ? normalizeSymbol(spinoffSymbolRaw) : null,
      spinoffShareRatio,
      spinoffBasisRetained,
      note,
      sourceHash,
    };

    const spinoffIncomplete =
      type === "spinoff" &&
      (!spinoffSymbolRaw || spinoffShareRatio === null || spinoffShareRatio <= 0 ||
        spinoffBasisRetained === null || spinoffBasisRetained < 0 || spinoffBasisRetained > 1);

    return {
      raw,
      draft,
      issues,
      skip: !date || !type || (needsSymbol && !symbolRaw) || spinoffIncomplete,
      duplicate: seen.has(sourceHash),
    };
  });
}
