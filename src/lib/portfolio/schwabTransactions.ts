import type { ISODate } from "@/domain";
import type { TransactionType } from "@/domain/portfolio";
import { schwabAccessToken } from "./schwabAuth";
import { fromSchwabSymbol } from "./schwabSymbol";

/**
 * Schwab's transaction history, reduced to rows a ledger can read.
 *
 * Schwab does not describe a transaction the way a statement does. It reports
 * an event plus a list of `transferItems` -- one leg per thing that moved --
 * and the same outer `type` covers economically opposite events. What kind of
 * transaction it was has to be worked out from the legs, and getting that
 * wrong is not loud: it books a plausible-looking row that quietly restates
 * the portfolio.
 *
 * Two of those traps are handled here explicitly, because both were found in
 * real account data rather than reasoned about in advance. See
 * `INTERNAL_JOURNALS` and the RECEIVE_AND_DELIVER branch.
 */

const BASE = "https://api.schwabapi.com/trader/v1";
const TIMEOUT_MS = 20_000;

/** Schwab serves at most a year of history per request. */
export const MAX_RANGE_DAYS = 365;

export interface SchwabAccount {
  /** Schwab's opaque per-account id, used in every other trader-API path. */
  hashValue: string;
  /** The real account number, shown only as its last four digits. */
  masked: string;
}

export interface SchwabLedgerRow {
  /** Schwab's own id for the event. Anchors dedupe to something that cannot
   *  drift when an unrelated field is restated. */
  activityId: string;
  accountHash: string;
  date: ISODate;
  /** Null when the legs did not say clearly enough what happened. */
  type: TransactionType | null;
  symbol: string | null;
  quantity: number;
  price: number;
  amount: number | null;
  fees: number;
  description: string;
  /** Notes carried into the review step; never silently dropped. */
  notes: string[];
}

export interface SchwabTransactionResult {
  rows: SchwabLedgerRow[];
  /** Events deliberately left out, with the reason, so the count reconciles. */
  ignored: { description: string; reason: string }[];
}

/* -------------------------------------------------------------------------- */
/* Schwab's wire shapes                                                        */
/* -------------------------------------------------------------------------- */

interface Instrument {
  symbol?: string;
  description?: string;
  assetType?: string;
  putCall?: string;
  underlyingSymbol?: string;
  expirationDate?: string;
  strikePrice?: number;
}

interface TransferItem {
  instrument?: Instrument;
  /** Signed: positive is into the account, negative is out of it. */
  amount?: number;
  cost?: number;
  price?: number;
  positionEffect?: string;
  feeType?: string;
}

interface SchwabTransaction {
  activityId?: number | string;
  time?: string;
  tradeDate?: string;
  type?: string;
  status?: string;
  subAccount?: string;
  description?: string;
  netAmount?: number;
  transferItems?: TransferItem[];
}

/** Asset types that represent a holding rather than cash or a fee. */
const SECURITY_ASSETS = new Set([
  "EQUITY",
  "OPTION",
  "COLLECTIVE_INVESTMENT",
  "MUTUAL_FUND",
  "FIXED_INCOME",
  "INDEX",
]);

/**
 * Journal wording for money that never left the account.
 *
 * Schwab journals cash between the cash and margin sides of one account, and
 * between the brokerage and its bank sweep, and reports each leg as an
 * ordinary cash movement. Both sides are real rows in the API and neither is
 * a deposit or a withdrawal -- the money is in the same account before and
 * after. Booking them would inflate cash by the full swept amount on every
 * sweep, in whichever direction happened to be imported.
 *
 * This is the single largest category in a real account: 140 of them against
 * 56 actual trades, so getting it wrong is not a rounding error.
 */
const INTERNAL_JOURNALS = [
  /TRF\s+FUNDS\s+(FRM|TO)\s+TYPE/i,
  /BANK\s+SWEEP\s+FR\s+BROKERAGE/i,
  /BROKERAGE\s+SWEEP\s+TO\s+BANK/i,
  /SWEEP/i,
];

function isoDate(value: string | undefined): ISODate | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) as ISODate;
}

/** The leg that moved a security, if any. */
function securityLeg(items: readonly TransferItem[]): TransferItem | null {
  return items.find((it) => !it.feeType && SECURITY_ASSETS.has(it.instrument?.assetType ?? "")) ?? null;
}

/**
 * Everything Schwab charged on the event, as one positive number.
 *
 * Every trade carries four fee legs whether or not they cost anything, so
 * these are summed rather than counted -- most are zero and the row should
 * still read as free.
 */
function feeTotal(items: readonly TransferItem[]): number {
  let total = 0;
  for (const item of items) {
    if (!item.feeType) continue;
    const value = typeof item.cost === "number" ? item.cost : (item.amount ?? 0);
    total += Math.abs(value);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Which side of a position a trade leg was on.
 *
 * The quantity's sign says which way the shares went and `positionEffect` says
 * whether that opened or closed something. Neither is enough alone: shares
 * arriving is a purchase when it opens a position and a cover when it closes
 * one, and those draw down entirely different lots.
 */
function tradeType(leg: TransferItem): TransactionType | null {
  const quantity = leg.amount ?? 0;
  if (quantity === 0) return null;
  const closing = (leg.positionEffect ?? "").toUpperCase() === "CLOSING";
  if (quantity > 0) return closing ? "buy_to_cover" : "buy";
  return closing ? "sell" : "short_sell";
}

/** The app's spelling of an instrument, including an option contract. */
function symbolOf(instrument: Instrument | undefined): string | null {
  const raw = instrument?.symbol?.trim();
  if (!raw) return null;
  return fromSchwabSymbol(raw);
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

interface Mapped {
  row: SchwabLedgerRow | null;
  ignore?: string;
}

function mapTransaction(tx: SchwabTransaction, accountHash: string): Mapped {
  const items = tx.transferItems ?? [];
  const date = isoDate(tx.tradeDate ?? tx.time);
  const description = (tx.description ?? "").trim();
  const outerType = (tx.type ?? "").toUpperCase();

  if (!date) return { row: null, ignore: "no usable date" };
  // A cancelled or rejected event never happened; only valid ones are history.
  if (tx.status && tx.status.toUpperCase() !== "VALID") {
    return { row: null, ignore: `status ${tx.status}` };
  }

  const base = {
    activityId: String(tx.activityId ?? ""),
    accountHash,
    date,
    description,
    notes: [] as string[],
  };

  const leg = securityLeg(items);
  const net = typeof tx.netAmount === "number" ? tx.netAmount : null;

  switch (outerType) {
    case "TRADE": {
      if (!leg) return { row: null, ignore: "trade with no security leg" };
      const type = tradeType(leg);
      if (!type) return { row: null, ignore: "trade leg moved no quantity" };
      return {
        row: {
          ...base,
          type,
          symbol: symbolOf(leg.instrument),
          quantity: Math.abs(leg.amount ?? 0),
          price: Math.abs(leg.price ?? 0),
          amount: net === null ? null : Math.abs(net),
          fees: feeTotal(items),
        },
      };
    }

    case "RECEIVE_AND_DELIVER": {
      if (!leg) return { row: null, ignore: "receive/deliver with no security leg" };
      const quantity = leg.amount ?? 0;
      if (quantity === 0) return { row: null, ignore: "receive/deliver moved no quantity" };
      const row: SchwabLedgerRow = {
        ...base,
        type: quantity > 0 ? "transfer_in" : "transfer_out",
        symbol: symbolOf(leg.instrument),
        quantity: Math.abs(quantity),
        price: Math.abs(leg.price ?? 0),
        amount: null,
        fees: 0,
      };
      // Schwab reports a transferred position with zero cost, so the basis and
      // acquisition date it was carrying elsewhere are simply not in this
      // response. On an account built by consolidating other brokerages these
      // are also the very positions most likely to be in the ledger already,
      // from the statements those brokerages issued -- and they will not hash
      // the same, so nothing else catches the collision.
      row.notes.push(
        "Transferred position: Schwab reports no cost basis, and this may already be in the ledger from the sending brokerage's own statement.",
      );
      return { row };
    }

    case "DIVIDEND_OR_INTEREST": {
      // Schwab names the security in prose here and nowhere else -- the only
      // leg is the cash. The symbol is resolved later against the ledger's own
      // holdings, where the names are known; see `schwabLedger`.
      // Schwab abbreviates: "SCHWAB1 INT 06/30", "BANK INT 07/31". The bare
      // "INT" has to be anchored to the date that follows it, or a company
      // written "INT'L PAPER" would start booking its dividends as interest.
      const interest = /interest|\bint\b\s*\d/i.test(description);
      return {
        row: {
          ...base,
          type: interest ? "interest" : "dividend",
          symbol: null,
          quantity: 0,
          price: 0,
          amount: net === null ? null : Math.abs(net),
          fees: 0,
        },
      };
    }

    case "JOURNAL": {
      if (INTERNAL_JOURNALS.some((pattern) => pattern.test(description))) {
        return { row: null, ignore: "internal journal -- money stayed in the account" };
      }
      if (net === null || net === 0) return { row: null, ignore: "journal moved no cash" };
      // A journal naming a security and taking cash out is a holding charge --
      // an ADR fee is the common one -- not a withdrawal of the user's money.
      const looksLikeSecurity = leg === null && description !== "" && !/journal|trf|transfer/i.test(description);
      if (looksLikeSecurity && net < 0) {
        return {
          row: { ...base, type: "fee", symbol: null, quantity: 0, price: 0, amount: Math.abs(net), fees: 0 },
        };
      }
      return {
        row: {
          ...base,
          type: net > 0 ? "cash_deposit" : "cash_withdrawal",
          symbol: null,
          quantity: 0,
          price: 0,
          amount: Math.abs(net),
          fees: 0,
        },
      };
    }

    case "ACH_RECEIPT":
    case "CASH_RECEIPT":
    case "WIRE_IN":
    case "ELECTRONIC_FUND":
    case "ACH_DISBURSEMENT":
    case "CASH_DISBURSEMENT":
    case "WIRE_OUT": {
      if (net === null || net === 0) return { row: null, ignore: "cash event moved no cash" };
      return {
        row: {
          ...base,
          type: net > 0 ? "cash_deposit" : "cash_withdrawal",
          symbol: null,
          quantity: 0,
          price: 0,
          amount: Math.abs(net),
          fees: 0,
        },
      };
    }

    // MEMORANDUM, SMA_ADJUSTMENT, MARGIN_CALL and friends record a state
    // change rather than a movement of money or shares.
    default:
      return { row: null, ignore: `unhandled type ${outerType || "(none)"}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

async function get<T>(path: string, token: string): Promise<T | null> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Every account the connection can see, with the number masked. */
export async function fetchSchwabAccounts(): Promise<SchwabAccount[] | null> {
  const token = await schwabAccessToken();
  if (!token) return null;
  const body = await get<{ accountNumber?: string; hashValue?: string }[]>(
    "/accounts/accountNumbers",
    token,
  );
  if (!body) return null;
  return body
    .filter((entry): entry is { accountNumber: string; hashValue: string } =>
      Boolean(entry.accountNumber && entry.hashValue),
    )
    .map((entry) => ({
      hashValue: entry.hashValue,
      // Only the last four ever leave this module. The full number is not
      // needed to tell two accounts apart and is not worth putting on screen.
      masked: `•••${entry.accountNumber.slice(-4)}`,
    }));
}

function schwabInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

/**
 * One account's transactions over a window, already reduced to ledger rows.
 *
 * `ignored` is returned rather than discarded so the review step can account
 * for every event Schwab sent: a sync that silently drops rows is impossible
 * to check, and these are exactly the rows whose omission would be correct in
 * one account and a missing deposit in another.
 */
export async function fetchSchwabTransactions(
  accountHash: string,
  from: Date,
  to: Date,
): Promise<SchwabTransactionResult | null> {
  const token = await schwabAccessToken();
  if (!token) return null;

  const query = new URLSearchParams({
    startDate: schwabInstant(from),
    endDate: schwabInstant(to),
  });
  const body = await get<SchwabTransaction[]>(
    `/accounts/${encodeURIComponent(accountHash)}/transactions?${query}`,
    token,
  );
  if (!body) return null;

  const rows: SchwabLedgerRow[] = [];
  const ignored: { description: string; reason: string }[] = [];

  for (const tx of body) {
    const mapped = mapTransaction(tx, accountHash);
    if (mapped.row) rows.push(mapped.row);
    else if (mapped.ignore) {
      ignored.push({ description: (tx.description ?? tx.type ?? "").trim(), reason: mapped.ignore });
    }
  }

  // Oldest first, the order a ledger is built in.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, ignored };
}

export const __testing = { mapTransaction, feeTotal, tradeType, INTERNAL_JOURNALS };
