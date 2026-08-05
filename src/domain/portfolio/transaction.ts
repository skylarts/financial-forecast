import { z } from "zod";
import { idSchema, isoDateSchema } from "../common";

/**
 * Every transaction type the ledger replays. The set is deliberately small:
 * anything a brokerage statement calls something more exotic gets mapped onto
 * one of these at import time.
 */
export const transactionTypeSchema = z.enum([
  "buy",
  "sell",
  /** Opens a short: borrowed shares sold, cash in, position owed. */
  "short_sell",
  /** Closes a short: shares bought back to return, cash out. */
  "buy_to_cover",
  /** Cash dividend paid out, no share change. */
  "dividend",
  /** Dividend or capital gain reinvested -- pays cash out and opens a new lot. */
  "reinvest",
  /** Ratio split; `quantity` carries the new-shares-per-old-share multiplier. */
  "split",
  /** Shares moved in from elsewhere, carrying their original basis and date. */
  "transfer_in",
  "transfer_out",
  "interest",
  "fee",
  "cash_deposit",
  "cash_withdrawal",
]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  buy: "Buy",
  sell: "Sell",
  short_sell: "Sell short",
  buy_to_cover: "Buy to cover",
  dividend: "Dividend",
  reinvest: "Reinvest",
  split: "Split",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  interest: "Interest",
  fee: "Fee",
  cash_deposit: "Deposit",
  cash_withdrawal: "Withdrawal",
};

/**
 * Transaction types grouped for the pickers. Opening a short and covering one
 * are kept in their own group rather than mixed in with ordinary buys and
 * sells, because choosing the wrong one silently changes which lots a trade
 * draws down -- and that is exactly the mistake that makes a legitimate short
 * look like selling shares you never owned.
 */
export const TRANSACTION_TYPE_GROUPS: { label: string; types: TransactionType[] }[] = [
  { label: "Buy / sell", types: ["buy", "sell"] },
  { label: "Short", types: ["short_sell", "buy_to_cover"] },
  { label: "Income", types: ["dividend", "reinvest", "interest"] },
  { label: "Transfers", types: ["transfer_in", "transfer_out"] },
  { label: "Other", types: ["split", "fee", "cash_deposit", "cash_withdrawal"] },
];

/**
 * Which direction a position runs. Long lots are shares owned; short lots are
 * shares owed, opened by selling borrowed stock and closed by buying it back.
 * Lots are tracked per side so a sell can never be matched against a short
 * position (or a cover against a long one), which is what stops a legitimate
 * short from reading as selling more shares than you hold.
 */
export type PositionSide = "long" | "short";

/** Types that change share count and therefore drive lot accounting. */
export const SHARE_TRANSACTION_TYPES: readonly TransactionType[] = [
  "buy",
  "sell",
  "short_sell",
  "buy_to_cover",
  "reinvest",
  "split",
  "transfer_in",
  "transfer_out",
];

/** Types that open a new tax lot, and the side they open it on. */
const LOT_OPENING: Partial<Record<TransactionType, PositionSide>> = {
  buy: "long",
  reinvest: "long",
  transfer_in: "long",
  short_sell: "short",
};

/** Types that close shares out of existing lots, and the side they close. */
const LOT_CLOSING: Partial<Record<TransactionType, PositionSide>> = {
  sell: "long",
  transfer_out: "long",
  buy_to_cover: "short",
};

/** The side this type opens a lot on, or null if it opens nothing. */
export function opensLotOn(type: TransactionType): PositionSide | null {
  return LOT_OPENING[type] ?? null;
}

/** The side this type closes lots on, or null if it closes nothing. */
export function closesLotOn(type: TransactionType): PositionSide | null {
  return LOT_CLOSING[type] ?? null;
}

/** True for the types that open a short rather than a long position. */
export function isShortType(type: TransactionType): boolean {
  return type === "short_sell" || type === "buy_to_cover";
}

export const transactionSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  date: isoDateSchema,
  type: transactionTypeSchema,
  /** Null for pure-cash rows (deposits, interest, account-level fees). */
  symbol: z.string().nullable().default(null),
  /** Shares, always positive. For a split, the multiplier (a 2:1 split is 2). */
  quantity: z.number().nonnegative().default(0),
  /** Per-share price in dollars. */
  price: z.number().nonnegative().default(0),
  /**
   * Total cash moved, positive. Left null it is derived as quantity * price
   * (plus or minus fees), which is what most statements imply.
   */
  amount: z.number().nullable().default(null),
  fees: z.number().nonnegative().default(0),
  /**
   * Which tax lot this row belongs to. A purchase carries the one lot it
   * opens; a sale carries the one or more lots it closes, comma-separated.
   * Anything arriving without one is assigned an id automatically -- generated
   * for a purchase, drawn oldest-first for a sale -- so every disposal traces
   * back to a specific acquisition. The user can overwrite either.
   */
  lotId: z.string().nullable().default(null),
  /**
   * For transfer_in: the date the shares were originally acquired, which is
   * what the holding period runs from -- not the transfer date.
   */
  acquiredDate: isoDateSchema.nullable().default(null),
  note: z.string().default(""),
  /** Groups rows that arrived in one import, so a bad import can be undone. */
  importBatchId: idSchema.nullable().default(null),
  /**
   * Fingerprint of the source row, used to skip re-importing rows that are
   * already in the ledger when a statement export overlaps a previous one.
   */
  sourceHash: z.string().nullable().default(null),
});
export type Transaction = z.infer<typeof transactionSchema>;

/**
 * Cash actually moved by a transaction, signed from the account's point of
 * view: negative means cash left the account. Statements are inconsistent about
 * whether `amount` includes fees, so an explicit amount is trusted as-is and
 * only a derived one has fees applied.
 */
export function signedCashFlow(tx: Transaction): number {
  const gross = tx.amount ?? tx.quantity * tx.price;
  const derived = tx.amount === null;
  switch (tx.type) {
    case "buy":
    case "reinvest":
    case "buy_to_cover":
      return -(derived ? gross + tx.fees : gross);
    case "sell":
    case "short_sell":
      return derived ? gross - tx.fees : gross;
    case "dividend":
    case "interest":
    case "cash_deposit":
      return gross;
    case "fee":
    case "cash_withdrawal":
      return -gross;
    case "split":
    case "transfer_in":
    case "transfer_out":
      return 0;
  }
}

/**
 * Dollars booked against a lot when it opens: cost paid for a long (its basis),
 * proceeds received for a short (what the cover has to beat). Fees always work
 * against you, so they add to a long's cost and subtract from a short's take.
 */
export function lotOpenValue(tx: Transaction): number {
  const gross = tx.amount ?? tx.quantity * tx.price;
  if (tx.amount !== null) return gross;
  return opensLotOn(tx.type) === "short" ? gross - tx.fees : gross + tx.fees;
}

/**
 * Dollars booked when a lot closes: proceeds received selling a long, cost paid
 * covering a short. Same fee asymmetry, in the same direction.
 */
export function lotCloseValue(tx: Transaction): number {
  const gross = tx.amount ?? tx.quantity * tx.price;
  if (tx.amount !== null) return gross;
  return closesLotOn(tx.type) === "short" ? gross + tx.fees : gross - tx.fees;
}
