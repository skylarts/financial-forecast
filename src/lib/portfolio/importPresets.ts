import {
  toOccSymbol,
  transactionTypeSchema,
  type OptionContract,
  type TransactionType,
} from "@/domain/portfolio";
import type { ColumnMapping } from "./importer";

/**
 * What each brokerage's export actually says, and what it means.
 *
 * Every ledger in this household was first built outside the app, by a script
 * per broker, because the generic importer guesses at wording -- and each
 * script relearned the same traps: Schwab splits a reinvestment into two rows
 * that both say "reinvest"; Fidelity puts the ticker in the description and
 * leaves the symbol column blank; a workplace plan names funds in prose and
 * tags every row with the money source. A preset carries that knowledge, so
 * the guesswork in `FIELD_PATTERNS` and `TYPE_PATTERNS` only runs for a file
 * nobody has taught it yet.
 *
 * A preset's action table is exact. Anything it does not list falls through
 * to the generic patterns *and is flagged for review*, because the whole
 * point is that a silently mistyped row is what corrupts a cash balance.
 */

export type ImportPresetId = "schwab" | "fidelity" | "workplace" | "ledger";

/** What a preset gets to look at for one row, already read out of its cells. */
export interface RowFacts {
  /** The action / activity cell, trimmed. */
  action: string;
  /** The description cell, trimmed; "" when the file has none. */
  description: string;
  /** The symbol cell, trimmed and as written. */
  symbol: string;
  quantity: number | null;
  price: number | null;
  amount: number | null;
}

export interface PresetResolution {
  /**
   * The type this row is, or null when the action is not in the table --
   * which hands the row to the generic patterns and marks it for review.
   */
  type: TransactionType | null;
  /**
   * Why the row is not a transaction at all: broker-internal bookkeeping that
   * moves no money in or out. The row is listed but not imported.
   */
  ignore?: string;
  /** A symbol read from somewhere other than the symbol cell, canonical-ready. */
  symbol?: string;
  /** A note for the review table when the table's answer needs explaining. */
  hint?: string;
}

export interface ImportPreset {
  id: ImportPresetId;
  label: string;
  /** One line under the picker saying what this preset knows. */
  hint: string;
  /** Whether a file with these headers (and first rows) is this broker's. */
  detect(headers: readonly string[], rows: readonly string[][]): boolean;
  /** Columns named outright, so nothing is left to the header patterns. */
  mapping(headers: readonly string[]): Partial<ColumnMapping>;
  resolve(facts: RowFacts): PresetResolution;
  /**
   * True when the symbol column holds a fund's *name* rather than a ticker,
   * so the importer must look each one up in the alias table the dialog
   * collects rather than storing the name as if it were a symbol.
   */
  symbolIsName?: boolean;
}

/** Index of the first header matching `pattern`, or null. */
function column(headers: readonly string[], pattern: RegExp): number | null {
  const index = headers.findIndex((h) => pattern.test(h.trim()));
  return index === -1 ? null : index;
}

function has(headers: readonly string[], pattern: RegExp): boolean {
  return column(headers, pattern) !== null;
}

/** Cash in or out, read from the sign of the amount. */
function cashBySign(amount: number | null): TransactionType | null {
  if (amount === null || amount === 0) return null;
  return amount < 0 ? "cash_withdrawal" : "cash_deposit";
}

/** Shares in or out by the sign of the quantity; cash by the amount otherwise. */
function transferBySign(facts: RowFacts): TransactionType | null {
  if (facts.quantity !== null && facts.quantity !== 0) {
    return facts.quantity < 0 ? "transfer_out" : "transfer_in";
  }
  return cashBySign(facts.amount);
}

// ---------------------------------------------------------------------------
// Schwab brokerage / IRA transaction download
// ---------------------------------------------------------------------------

/**
 * Schwab's action vocabulary, from every export this household has pulled.
 *
 * The reinvestment pair is the trap: "Reinvest Dividend" and "Qual Div
 * Reinvest" are the dividend being credited -- cash in -- and only "Reinvest
 * Shares" is the purchase that spends it. A rule keyed on the word "reinvest"
 * books each dividend backwards.
 *
 * Entries mapped to `null` are real transactions whose direction is only in
 * the sign: a journal between two Schwab accounts, a MoneyLink transfer, a
 * wire. The row resolves by sign rather than by wording.
 */
const SCHWAB_ACTIONS: Record<string, TransactionType | "sign" | "transfer"> = {
  buy: "buy",
  sell: "sell",
  "buy to open": "buy",
  "buy to close": "buy_to_cover",
  "sell to open": "short_sell",
  "sell to close": "sell",
  "sell short": "short_sell",
  "buy to cover": "buy_to_cover",
  assigned: "option_assign",
  "exchange or exercise": "option_exercise",
  expired: "option_expire",
  "cash dividend": "dividend",
  "qualified dividend": "dividend",
  "non-qualified div": "dividend",
  "special dividend": "dividend",
  "pr yr cash div": "dividend",
  "pr yr div reinvest": "dividend",
  "long term cap gain": "dividend",
  "short term cap gain": "dividend",
  "reinvest dividend": "dividend",
  "qual div reinvest": "dividend",
  "reinvest shares": "reinvest",
  "bank interest": "interest",
  "credit interest": "interest",
  "bond interest": "interest",
  "margin interest": "fee",
  "service fee": "fee",
  "foreign tax paid": "fee",
  "adr mgmt fee": "fee",
  "misc cash entry": "sign",
  "moneylink transfer": "sign",
  "moneylink deposit": "sign",
  "moneylink adj": "sign",
  journal: "sign",
  "wire received": "sign",
  "wire sent": "sign",
  "wire funds": "sign",
  "funds received": "sign",
  "funds paid": "sign",
  "internal transfer": "transfer",
  "security transfer": "transfer",
  "journaled shares": "transfer",
};

const schwab: ImportPreset = {
  id: "schwab",
  label: "Schwab CSV",
  hint: "The transactions download from schwab.com, for a brokerage or an IRA.",
  detect(headers) {
    return (
      has(headers, /^date$/i) &&
      has(headers, /^action$/i) &&
      has(headers, /^fees & comm$/i) &&
      has(headers, /^amount$/i) &&
      has(headers, /^symbol$/i)
    );
  },
  mapping(headers) {
    return {
      date: column(headers, /^date$/i),
      type: column(headers, /^action$/i),
      symbol: column(headers, /^symbol$/i),
      quantity: column(headers, /^quantity$/i),
      price: column(headers, /^price$/i),
      fees: column(headers, /^fees & comm$/i),
      amount: column(headers, /^amount$/i),
      note: column(headers, /^description$/i),
    };
  },
  resolve(facts) {
    const key = facts.action.toLowerCase().replace(/\s+/g, " ");
    const rule = SCHWAB_ACTIONS[key];
    if (rule === undefined) {
      if (/split/i.test(key)) {
        return {
          type: null,
          hint: "Schwab lists the shares a split added, not its ratio. Skip this row and add the split from the calendar below instead.",
        };
      }
      return { type: null };
    }
    if (rule === "sign") return { type: cashBySign(facts.amount) };
    if (rule === "transfer") return { type: transferBySign(facts) };
    return { type: rule };
  },
};

// ---------------------------------------------------------------------------
// Fidelity brokerage history download
// ---------------------------------------------------------------------------

/**
 * Fidelity writes the action and the security's name into one cell -- "YOU
 * BOUGHT MICROSOFT CORP (MSFT) (Margin)" -- and often leaves the symbol column
 * blank, so both the type and the ticker have to be read out of that prose.
 * Rules are tested in order; the short and option wordings come first because
 * every one of them also contains "BOUGHT" or "SOLD".
 */
const FIDELITY_RULES: [RegExp, TransactionType | "sign" | "transfer" | "ignore"][] = [
  [/^you bought short cover/i, "buy_to_cover"],
  [/^you sold short sale/i, "short_sell"],
  [/^you bought opening transaction/i, "buy"],
  [/^you bought closing transaction/i, "buy_to_cover"],
  [/^you sold opening transaction/i, "short_sell"],
  [/^you sold closing transaction/i, "sell"],
  [/^you bought/i, "buy"],
  [/^you sold/i, "sell"],
  [/^dividend received/i, "dividend"],
  [/^reinvestment/i, "reinvest"],
  [/^interest earned|^interest\b/i, "interest"],
  [/^electronic funds transfer received|^direct deposit|^other credit/i, "cash_deposit"],
  [/^electronic funds transfer paid|^other debit|^direct debit/i, "cash_withdrawal"],
  [/^transferred (from|to) vs/i, "sign"],
  [/^transfer of assets/i, "transfer"],
  [/^fee charged|^foreign tax paid|^margin interest|^corp int adjustment/i, "fee"],
  [/^short vs margin mark to market/i, "ignore"],
];

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * A contract as Fidelity spells one in prose: "CALL (MQ) MARQETA INC CLASS A
 * JAN 15 27 $5.5 (100 SHS)". The symbol column is usually blank for these.
 */
const FIDELITY_CONTRACT =
  /\b(CALL|PUT)\s+\(([A-Z][A-Z0-9]{0,5})\)\s+.*?\b([A-Z]{3})\s+(\d{1,2})\s+(\d{2})\s+\$(\d+(?:\.\d+)?)/i;

/** The ticker Fidelity tucks into the action text, or null. A nine-character
 *  parenthetical is a CUSIP, not a ticker, and is left alone. */
function fidelitySymbol(facts: RowFacts): string | undefined {
  const written = facts.symbol.replace(/^-/, "").trim();
  if (written) return written;
  const contract = FIDELITY_CONTRACT.exec(facts.action);
  if (contract) {
    const [, right, root, mon, day, yy, strike] = contract;
    const month = MONTHS[mon.toLowerCase()];
    if (month) {
      const parsed: OptionContract = {
        underlying: root.toUpperCase(),
        expiry: `20${yy}-${month}-${day.padStart(2, "0")}`,
        right: right.toUpperCase() === "CALL" ? "call" : "put",
        strike: Number(strike),
      };
      return toOccSymbol(parsed);
    }
  }
  const ticker = /\(([A-Z]{1,5})\)/.exec(facts.action);
  return ticker ? ticker[1] : undefined;
}

const fidelity: ImportPreset = {
  id: "fidelity",
  label: "Fidelity CSV",
  hint: "The history download from fidelity.com. The ticker is read out of the action text when the symbol column is blank.",
  detect(headers) {
    return (
      has(headers, /^run date$/i) &&
      has(headers, /^action$/i) &&
      (has(headers, /^settlement date$/i) || has(headers, /^exchange quantity$/i))
    );
  },
  mapping(headers) {
    return {
      date: column(headers, /^run date$/i),
      type: column(headers, /^action$/i),
      symbol: column(headers, /^symbol$/i),
      quantity: column(headers, /^quantity$/i),
      price: column(headers, /^price$/i),
      // Fidelity keeps commission and fees apart; commissions are zero on
      // every row seen here, and the option fees live in "Fees".
      fees: column(headers, /^fees$/i),
      amount: column(headers, /^amount$/i),
      note: column(headers, /^description$/i),
    };
  },
  resolve(facts) {
    const symbol = fidelitySymbol(facts);
    for (const [pattern, rule] of FIDELITY_RULES) {
      if (!pattern.test(facts.action)) continue;
      if (rule === "ignore") {
        return {
          type: null,
          ignore: "Fidelity's own bookkeeping between the margin and short sides of the account. Moves no money in or out.",
        };
      }
      if (rule === "sign") return { type: cashBySign(facts.amount), symbol };
      if (rule === "transfer") return { type: transferBySign(facts), symbol };
      return { type: rule, symbol };
    }
    return { type: null, symbol };
  },
};

// ---------------------------------------------------------------------------
// Workplace plan export (Schwab Retirement Plan Services, Empower and kin)
// ---------------------------------------------------------------------------

/**
 * Fund names as a plan's export prints them, with the ticker each was
 * confirmed to be by matching the export's own prices against the fund's NAV.
 * Seeds the alias table in the dialog; anything not here is asked for.
 */
export const KNOWN_FUND_TICKERS: Record<string, string> = {
  "Fidelity Small Cap Index": "FSSNX",
  "Schwab 1000 Index": "SNXFX",
  "Schwab Fundamental Emerging Mkts Eq Idx": "SFENX",
  "Schwab Fundamental Intl Equity Index Fd": "SFNNX",
  "Schwab Fundamental Intl Sm Eq Idx": "SFILX",
  "Schwab Fundamental US Large Company Idx": "SFLNX",
  "Schwab Fundamental US Small Company Idx": "SFSNX",
  "Schwab International Index": "SWISX",
  "Schwab Treasury Infl Protected Secs Idx": "SWRSX",
  "Vanguard Emerging Mkts Stock Idx InsPlus": "VEMRX",
  "Vanguard Emerging Mkts Stock Idx Instl": "VEMIX",
  "Vanguard Real Estate Index Institutional": "VGSNX",
  "Vanguard Total Bond Market Idx InstlPls": "VBMPX",
  "Vanguard Institutional Total Bond Mkt Index": "VBTIX",
};

/** Investments that are the account's cash rather than a position. */
const CASH_INVESTMENT = /^cash$|money market|cash reserve/i;

/** Whether a plan export's investment name is its cash fund, not a holding. */
export function isPlanCashName(name: string): boolean {
  return CASH_INVESTMENT.test(name.trim());
}

/**
 * The export is strict double entry: every event is a cash row and a units
 * row, each repeated per money source. Both halves are real and both are kept
 * -- except cash moving within cash, which the ledger's own replay already
 * implies.
 */
function resolveWorkplace(facts: RowFacts): PresetResolution {
  const activity = facts.action.toLowerCase();
  const desc = facts.description;
  const isCash = CASH_INVESTMENT.test(facts.symbol);

  if (/stock split/i.test(desc)) {
    return {
      type: null,
      hint: "The export lists the shares a split added, not its ratio. Skip this row and add the split from the calendar below instead.",
    };
  }

  if (isCash) {
    if (activity === "purchase" || activity === "sale") {
      return {
        type: null,
        symbol: "",
        ignore: "Cash moving within the plan's cash fund. The ledger replays cash on its own.",
      };
    }
    if (activity === "cash receipts") {
      return { type: /interest/i.test(desc) ? "interest" : "cash_deposit", symbol: "" };
    }
    if (activity === "cash disbursement") {
      if (/fee/i.test(desc)) return { type: "fee", symbol: "" };
      if (/withdraw|distribution|loan/i.test(desc)) return { type: "cash_withdrawal", symbol: "" };
      return { type: null, symbol: "" };
    }
    return { type: null, symbol: "" };
  }

  const isIncome = /dividend|capital gain/i.test(desc);
  switch (activity) {
    case "cash receipts":
      // Only a real distribution is a dividend. Interest and an expense
      // reimbursement are credited against the fund but are not its income.
      return isIncome ? { type: "dividend" } : { type: "interest", symbol: "" };
    case "purchase":
      return { type: isIncome ? "reinvest" : "buy" };
    case "sale":
      return { type: "sell" };
    case "cash disbursement":
      return { type: "fee", symbol: "" };
    default:
      return { type: null };
  }
}

const workplace: ImportPreset = {
  id: "workplace",
  label: "Workplace plan export",
  hint: "A 401(k) or 457 transaction export with Investment, Contribution and Activity columns. Funds are named, not tickered, so each name is mapped to a ticker below.",
  symbolIsName: true,
  detect(headers) {
    return (
      has(headers, /^transaction date$/i) &&
      has(headers, /^investment$/i) &&
      has(headers, /^activity$/i) &&
      has(headers, /^units$/i)
    );
  },
  mapping(headers) {
    return {
      date: column(headers, /^transaction date$/i),
      type: column(headers, /^activity$/i),
      symbol: column(headers, /^investment$/i),
      quantity: column(headers, /^units$/i),
      price: column(headers, /^price$/i),
      amount: column(headers, /^amount$/i),
      taxSource: column(headers, /^contribution$/i),
      note: column(headers, /^description$/i),
      fees: null,
    };
  },
  resolve: resolveWorkplace,
};

// ---------------------------------------------------------------------------
// This app's own CSV export, and the Schwab API fetch that borrows its shape
// ---------------------------------------------------------------------------

const ledger: ImportPreset = {
  id: "ledger",
  label: "This app's export",
  hint: "A CSV this app wrote, or the Schwab fetch above. The type column is already in the ledger's own words.",
  detect(headers, rows) {
    const action = column(headers, /^action$/i);
    if (action === null || !has(headers, /^symbol$/i)) return false;
    // The header alone is generic; what marks the file is that the action
    // cells are the ledger's exact type names rather than a broker's prose.
    const sample = rows.slice(0, 20).map((r) => (r[action] ?? "").trim()).filter(Boolean);
    return (
      sample.length > 0 &&
      sample.every((a) => transactionTypeSchema.safeParse(a.toLowerCase().replace(/[\s-]+/g, "_")).success)
    );
  },
  mapping() {
    return {};
  },
  resolve(facts) {
    const exact = transactionTypeSchema.safeParse(facts.action.toLowerCase().replace(/[\s-]+/g, "_"));
    return { type: exact.success ? exact.data : null };
  },
};

export const IMPORT_PRESETS: readonly ImportPreset[] = [schwab, fidelity, workplace, ledger];

export function presetById(id: ImportPresetId): ImportPreset {
  const preset = IMPORT_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown import preset: ${id}`);
  return preset;
}

/**
 * The preset a file is for, judged from its header row and first rows, or
 * null when it is nobody's -- which hands the whole file to the generic
 * patterns, exactly as before presets existed.
 *
 * Order matters only where two could claim a file: the broker presets test
 * for columns no other export carries, and the app's own export is last
 * because its header is the most ordinary of the four.
 */
export function detectPreset(headers: readonly string[], rows: readonly string[][]): ImportPreset | null {
  for (const preset of IMPORT_PRESETS) {
    if (preset.detect(headers, rows)) return preset;
  }
  return null;
}
