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

/** Types that change share count and therefore drive lot accounting. */
export const SHARE_TRANSACTION_TYPES: readonly TransactionType[] = [
  "buy",
  "sell",
  "reinvest",
  "split",
  "transfer_in",
  "transfer_out",
];

/** Types that open a new tax lot. */
export const LOT_OPENING_TYPES: readonly TransactionType[] = ["buy", "reinvest", "transfer_in"];

/** Types that close shares out of existing lots. */
export const LOT_CLOSING_TYPES: readonly TransactionType[] = ["sell", "transfer_out"];

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
   * The statement's own lot identifier. When a sell carries one, the lot
   * engine closes exactly that lot instead of falling back to FIFO -- this is
   * what keeps realized gains matching what the brokerage actually reported.
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
      return -(derived ? gross + tx.fees : gross);
    case "sell":
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

/** Total dollars paid to open a lot, fees included -- the cost basis. */
export function lotCostBasis(tx: Transaction): number {
  const gross = tx.amount ?? tx.quantity * tx.price;
  return tx.amount === null ? gross + tx.fees : gross;
}

/** Proceeds received when closing shares, net of fees. */
export function saleProceeds(tx: Transaction): number {
  const gross = tx.amount ?? tx.quantity * tx.price;
  return tx.amount === null ? gross - tx.fees : gross;
}
