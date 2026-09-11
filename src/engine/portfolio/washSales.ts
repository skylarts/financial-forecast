import type { ISODate } from "@/domain";
import { normalizeSymbol, opensLotOn, type Transaction } from "@/domain/portfolio";
import type { ClosedLot } from "./lots";

/**
 * Loss lots the wash-sale rule may reach.
 *
 * A loss on a sale is disallowed for the year if substantially identical
 * shares were bought within thirty days before or after it -- sixty-one days
 * counting the sale itself -- and the disallowed amount is added to the basis
 * of the replacement shares instead. That reaches across every account the
 * taxpayer holds, IRAs included, which is why the check runs over the whole
 * ledger in scope rather than the lot's own account.
 *
 * This only *flags*. Adjusting basis needs the replacement lot identified and
 * the loss carried into it, and the broker's 1099-B is the document that
 * actually decides it; a flag says "look here before you count this loss",
 * which is the question a person can act on.
 */

/** Days on either side of the sale that a purchase counts as a replacement. */
export const WASH_SALE_WINDOW_DAYS = 30;

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * The closed lots whose loss a purchase in the window may disallow.
 *
 * Only taxable long lots at a loss are candidates. A purchase is any row that
 * opens a long lot -- a buy, a reinvested dividend, shares transferred in --
 * except the purchase that opened the lot being sold, which is the shares
 * themselves and not their replacement. The lot's opening row is excluded
 * by id rather than by date, so a same-day round trip is still caught when a
 * *second* buy landed that day.
 */
export function flagWashSales(
  closedLots: readonly ClosedLot[],
  transactions: readonly Transaction[],
): Set<ClosedLot> {
  const purchasesBySymbol = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.symbol === null || opensLotOn(tx.type) !== "long" || tx.quantity <= 0) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const list = purchasesBySymbol.get(symbol);
    if (list) list.push(tx);
    else purchasesBySymbol.set(symbol, [tx]);
  }

  const flagged = new Set<ClosedLot>();
  for (const lot of closedLots) {
    if (!lot.taxable || lot.unmatched || lot.side !== "long" || lot.gain >= 0) continue;
    const purchases = purchasesBySymbol.get(lot.symbol);
    if (!purchases) continue;
    const replaced = purchases.some(
      (tx) => tx.id !== lot.openTxId && daysBetween(tx.date, lot.disposedDate) <= WASH_SALE_WINDOW_DAYS,
    );
    if (replaced) flagged.add(lot);
  }
  return flagged;
}
