import type { Transaction } from "@/domain/portfolio";

/** Rounds to a fixed number of decimals without the float noise `toFixed` leaves. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * True for a row whose `quantity` is a share count, and so can be divided.
 *
 * A split carries a ratio there (a 2:1 split is a 2) and a spinoff carries a
 * share ratio; halving either would quietly change what the row does to every
 * lot it touches rather than dividing an amount of money. Those rows are left
 * whole -- a corporate action applies to the shares in an account, so it
 * belongs on whichever sleeve holds them, not across both.
 */
export function isDivisible(tx: Transaction): boolean {
  return tx.type !== "split" && tx.type !== "spinoff";
}

/**
 * Divides one row along `fraction`: the part that moves to another account,
 * and the part that stays.
 *
 * For the quarterly statements that print fund activity combined and report
 * the pre-tax/Roth split only as a summary. The two halves are ordinary rows
 * in ordinary accounts, so everything downstream -- lots, cash, performance --
 * treats them exactly as it would treat two statement lines.
 *
 * The moved part is the rounded one and the remainder is whatever is left, so
 * the pair adds back to the original to the cent and to the share however the
 * fraction divides. That matters more than it looks: these splits are checked
 * against the per-source balance the statement states, and a rounding drift
 * repeated over six years of quarters is exactly what would make that
 * reconciliation fail for no real reason.
 *
 * Both halves keep the source row's fingerprint. They both came from it, and
 * re-importing that statement should still recognise the row as one already in
 * the ledger. Lot ids are cleared: a lot belongs to one account's ledger, so
 * each half re-derives its own where it now lives.
 */
export function splitTransactionByFraction(
  tx: Transaction,
  toAccountId: string,
  fraction: number,
  newId: string,
): { kept: Transaction; moved: Transaction } | null {
  if (!(fraction > 0 && fraction < 1)) return null;
  if (!isDivisible(tx)) return null;
  if (tx.accountId === toAccountId) return null;

  const movedQuantity = round(tx.quantity * fraction, 6);
  const movedFees = round(tx.fees * fraction, 2);
  const movedAmount = tx.amount === null ? null : round(tx.amount * fraction, 2);

  return {
    kept: {
      ...tx,
      quantity: round(tx.quantity - movedQuantity, 6),
      fees: round(tx.fees - movedFees, 2),
      amount: tx.amount === null || movedAmount === null ? null : round(tx.amount - movedAmount, 2),
      lotId: null,
    },
    moved: {
      ...tx,
      id: newId,
      accountId: toAccountId,
      quantity: movedQuantity,
      fees: movedFees,
      amount: movedAmount,
      lotId: null,
    },
  };
}
