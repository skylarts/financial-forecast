import type { Transaction } from "@/domain/portfolio";

/**
 * Recognising a deposit as the other end of a withdrawal from one of this
 * portfolio's own accounts, rather than as money from outside.
 *
 * A Roth contribution journaled out of the brokerage shows up as a withdrawal
 * on one statement and a deposit on the other. Both rows are real -- each
 * account's cash really moved -- so both stay in the ledger with their types
 * untouched. What this adds is the link between them, so a view asking "how
 * much did I put in this year" can tell a contribution from a rearrangement,
 * and the transactions list can say which account the money went to.
 */

/** The matched row, and the file row's date it was matched to. */
export interface TransferPeer {
  transaction: Transaction;
  /** Calendar days between the two rows; 0 for a same-day journal. */
  daysApart: number;
}

/**
 * How far apart the two halves may post.
 *
 * A journal between two accounts at one custodian lands the same day; an ACH
 * between custodians takes one to three. Wider than that and a deposit that
 * merely equals a withdrawal starts matching things it is not.
 */
export const TRANSFER_MATCH_DAYS = 3;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Dollars a cash row moved, positive, whether the amount was stated or derived. */
function cashAmount(tx: { amount: number | null; quantity: number; price: number }): number {
  return Math.abs(tx.amount ?? tx.quantity * tx.price);
}

/**
 * The candidate that is the other half of `row`, or null.
 *
 * Opposite direction, the same dollars to the cent, and within
 * {@link TRANSFER_MATCH_DAYS}; the nearest date wins when several qualify.
 * The candidates are whatever the caller has not already paired -- each row
 * can be one transfer's other half, and only one.
 */
export function findTransferPeer(
  row: { date: string; type: string; amount: number | null; quantity: number; price: number },
  candidates: Iterable<Transaction>,
): TransferPeer | null {
  const wanted = row.type === "cash_deposit" ? "cash_withdrawal" : row.type === "cash_withdrawal" ? "cash_deposit" : null;
  if (wanted === null) return null;
  const dollars = Math.round(cashAmount(row) * 100);
  if (dollars === 0) return null;

  let best: TransferPeer | null = null;
  for (const candidate of candidates) {
    if (candidate.type !== wanted) continue;
    if (Math.round(cashAmount(candidate) * 100) !== dollars) continue;
    const daysApart = daysBetween(row.date, candidate.date);
    if (daysApart > TRANSFER_MATCH_DAYS) continue;
    if (best === null || daysApart < best.daysApart) best = { transaction: candidate, daysApart };
  }
  return best;
}
