import {
  closesLotOn,
  createLotIdMinter,
  formatLotIds,
  opensLotOn,
  parseLotIds,
  type Portfolio,
  type Transaction,
} from "@/domain/portfolio";
import { buildLotLedger } from "@/engine/portfolio/lots";

/** True for a row that actually opens a lot the engine will track. */
function opensRealLot(tx: Transaction): boolean {
  return opensLotOn(tx.type) !== null && tx.symbol !== null && tx.quantity > 0;
}

/** True for a row that actually draws lots down. */
function closesRealLot(tx: Transaction): boolean {
  return closesLotOn(tx.type) !== null && tx.symbol !== null && tx.quantity > 0;
}

/**
 * Fills in the lot ids a ledger is missing, so every share disposed of points
 * back at the purchase it came from.
 *
 * Brokerage exports mostly don't carry lot ids at all -- Schwab's certainly
 * doesn't -- which leaves the tracker guessing FIFO silently on every sale and
 * gives the user nothing to correct when the guess is wrong. Writing the ids
 * down makes the match visible and editable: purchases get a generated id,
 * sales get the ids of the lots oldest-first accounting actually drew on.
 *
 * Only rows lacking an id are touched, so an id the user typed, a statement
 * supplied, or an earlier pass generated is never rewritten. That also makes
 * this safe to re-run after every edit, which is how a sale re-derives its
 * match when the purchases behind it change.
 */
export function assignLotIds(transactions: Transaction[]): Transaction[] {
  const minter = createLotIdMinter(transactions.flatMap((tx) => parseLotIds(tx.lotId)));
  const assigned = new Map<string, string>();

  // Minted in date order rather than array order so the trailing counter reads
  // in the order the lots were actually acquired, whatever order the rows were
  // entered or imported in.
  const chronological = transactions
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => (a.tx.date === b.tx.date ? a.index - b.index : a.tx.date < b.tx.date ? -1 : 1));

  for (const { tx } of chronological) {
    if (tx.lotId !== null || !opensRealLot(tx)) continue;
    assigned.set(tx.id, minter.mint(tx.symbol ?? "", tx.acquiredDate ?? tx.date));
  }

  const stamped = transactions.map((tx) => {
    const lotId = assigned.get(tx.id);
    return lotId === undefined ? tx : { ...tx, lotId };
  });

  // Sales are matched by replaying the freshly stamped ledger rather than by
  // repeating FIFO here, so what gets written down is exactly what the engine
  // would have done anyway -- the two can't drift apart.
  const drawnFrom = new Map<string, string[]>();
  for (const lot of buildLotLedger(stamped).closedLots) {
    // A lot the ledger invented to absorb an oversell has no purchase behind
    // it; naming it on the sale would invite the user to trust a phantom.
    if (lot.unmatched) continue;
    const ids = drawnFrom.get(lot.closeTxId) ?? [];
    if (!ids.includes(lot.id)) ids.push(lot.id);
    drawnFrom.set(lot.closeTxId, ids);
  }

  let changed = assigned.size > 0;
  const result = stamped.map((tx) => {
    if (tx.lotId !== null || !closesRealLot(tx)) return tx;
    const lotId = formatLotIds(drawnFrom.get(tx.id) ?? []);
    if (lotId === null) return tx;
    changed = true;
    return { ...tx, lotId };
  });

  return changed ? result : transactions;
}

/** `assignLotIds` over a whole portfolio, returning it unchanged when there
 *  was nothing to fill in so callers can skip a needless write. */
export function withAssignedLotIds(portfolio: Portfolio): Portfolio {
  const transactions = assignLotIds(portfolio.transactions);
  return transactions === portfolio.transactions ? portfolio : { ...portfolio, transactions };
}
