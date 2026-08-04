import type { ISODate, Id } from "@/domain";
import {
  LOT_CLOSING_TYPES,
  LOT_OPENING_TYPES,
  lotCostBasis,
  normalizeSymbol,
  saleProceeds,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";

/** Share counts below this are treated as fully depleted, not as a sliver of a
 *  lot left behind by floating-point division. */
const EPSILON = 1e-9;

export interface OpenLot {
  /** The statement's lot id when it gave one, else the opening transaction's id. */
  id: string;
  accountId: Id;
  symbol: string;
  acquiredDate: ISODate;
  /** Shares still held. */
  quantity: number;
  /** Basis of the shares still held. */
  costBasis: number;
  openTxId: Id;
}

export type HoldingTerm = "short" | "long";

export interface ClosedLot {
  id: string;
  accountId: Id;
  symbol: string;
  acquiredDate: ISODate;
  disposedDate: ISODate;
  quantity: number;
  costBasis: number;
  proceeds: number;
  gain: number;
  term: HoldingTerm;
  /**
   * False for shares moved out to another account. They deplete the lot but
   * realize nothing, and counting their zero proceeds as a total loss would
   * corrupt every realized-gain figure downstream.
   */
  taxable: boolean;
  openTxId: Id;
  closeTxId: Id;
}

export interface LedgerWarning {
  txId: Id;
  date: ISODate;
  symbol: string;
  message: string;
}

export interface LotLedger {
  openLots: OpenLot[];
  closedLots: ClosedLot[];
  warnings: LedgerWarning[];
}

/**
 * Same-day ordering. A statement gives no intraday timestamps, so a buy and a
 * sell of the same symbol on the same day would otherwise resolve in whatever
 * order the file happened to list them -- and a sell sorted ahead of its own
 * buy looks like an oversell. Opening first, then splits, then closings is the
 * only ordering that never manufactures a phantom disposal.
 */
function typeRank(type: TransactionType): number {
  if (LOT_OPENING_TYPES.includes(type)) return 0;
  if (type === "split") return 1;
  if (LOT_CLOSING_TYPES.includes(type)) return 2;
  return 3;
}

function sortForReplay(transactions: readonly Transaction[]): Transaction[] {
  return transactions
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => {
      if (a.tx.date !== b.tx.date) return a.tx.date < b.tx.date ? -1 : 1;
      const rank = typeRank(a.tx.type) - typeRank(b.tx.type);
      if (rank !== 0) return rank;
      return a.index - b.index;
    })
    .map((entry) => entry.tx);
}

/** A disposal is long-term only if held for more than a year, counting from the
 *  day after acquisition -- the IRS holding-period rule. */
export function holdingTerm(acquiredDate: ISODate, disposedDate: ISODate): HoldingTerm {
  const acquired = new Date(`${acquiredDate}T00:00:00`);
  const oneYearOn = new Date(acquired);
  oneYearOn.setFullYear(oneYearOn.getFullYear() + 1);
  return new Date(`${disposedDate}T00:00:00`) > oneYearOn ? "long" : "short";
}

function positionKey(accountId: Id, symbol: string): string {
  return `${accountId}::${symbol}`;
}

/**
 * Replays a transaction ledger into open and closed tax lots.
 *
 * Disposals honor the statement's own lot id when it carries one, which keeps
 * realized gains matching what the brokerage reported; without one they fall
 * back to FIFO. Selling more shares than the ledger knows about is recorded
 * against a zero-basis lot and flagged -- an imported history that starts
 * mid-stream is normal, and dropping the sale entirely would understate
 * proceeds far more badly than an overstated gain does.
 */
export function buildLotLedger(transactions: readonly Transaction[]): LotLedger {
  const open = new Map<string, OpenLot[]>();
  const closedLots: ClosedLot[] = [];
  const warnings: LedgerWarning[] = [];

  for (const tx of sortForReplay(transactions)) {
    if (tx.symbol === null) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const key = positionKey(tx.accountId, symbol);
    const lots = open.get(key) ?? [];
    if (!open.has(key)) open.set(key, lots);

    if (LOT_OPENING_TYPES.includes(tx.type)) {
      if (tx.quantity <= 0) continue;
      lots.push({
        id: tx.lotId ?? tx.id,
        accountId: tx.accountId,
        symbol,
        acquiredDate: tx.acquiredDate ?? tx.date,
        quantity: tx.quantity,
        costBasis: lotCostBasis(tx),
        openTxId: tx.id,
      });
      continue;
    }

    if (tx.type === "split") {
      const ratio = tx.quantity;
      if (ratio <= 0) {
        warnings.push({
          txId: tx.id,
          date: tx.date,
          symbol,
          message: "Split ignored: the share ratio must be greater than zero.",
        });
        continue;
      }
      // Basis per lot is unchanged by a split; only the share count moves.
      for (const lot of lots) lot.quantity *= ratio;
      continue;
    }

    if (!LOT_CLOSING_TYPES.includes(tx.type)) continue;
    if (tx.quantity <= 0) continue;

    let remaining = tx.quantity;
    const proceeds = tx.type === "sell" ? saleProceeds(tx) : 0;
    const perShareProceeds = proceeds / tx.quantity;

    const named = tx.lotId ? lots.filter((lot) => lot.id === tx.lotId) : [];
    if (tx.lotId && named.length === 0) {
      warnings.push({
        txId: tx.id,
        date: tx.date,
        symbol,
        message: `Lot "${tx.lotId}" named by this sale isn't open — fell back to oldest-first.`,
      });
    }
    // Specific identification when the statement named a lot, oldest-first
    // otherwise. Lots are appended in replay order, which is already
    // date-ascending, so the array itself is the FIFO queue.
    const candidates = named.length > 0 ? named : lots;

    for (const lot of candidates) {
      if (remaining <= EPSILON) break;
      if (lot.quantity <= EPSILON) continue;
      const taken = Math.min(lot.quantity, remaining);
      const basis = (lot.costBasis / lot.quantity) * taken;
      const share = perShareProceeds * taken;

      closedLots.push({
        id: lot.id,
        accountId: tx.accountId,
        symbol,
        acquiredDate: lot.acquiredDate,
        disposedDate: tx.date,
        quantity: taken,
        costBasis: basis,
        proceeds: share,
        gain: share - basis,
        term: holdingTerm(lot.acquiredDate, tx.date),
        taxable: tx.type === "sell",
        openTxId: lot.openTxId,
        closeTxId: tx.id,
      });

      lot.quantity -= taken;
      lot.costBasis -= basis;
      remaining -= taken;
    }

    if (remaining > EPSILON) {
      const share = perShareProceeds * remaining;
      closedLots.push({
        id: `${tx.id}-unmatched`,
        accountId: tx.accountId,
        symbol,
        acquiredDate: tx.date,
        disposedDate: tx.date,
        quantity: remaining,
        costBasis: 0,
        proceeds: share,
        gain: share,
        term: "short",
        taxable: tx.type === "sell",
        openTxId: tx.id,
        closeTxId: tx.id,
      });
      warnings.push({
        txId: tx.id,
        date: tx.date,
        symbol,
        message: `Sold ${remaining.toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })} more shares than the ledger holds — counted at zero cost basis, so the gain is overstated. Add the missing purchase.`,
      });
    }

    open.set(
      key,
      lots.filter((lot) => lot.quantity > EPSILON),
    );
  }

  const openLots = [...open.values()].flat().filter((lot) => lot.quantity > EPSILON);
  return { openLots, closedLots, warnings };
}
