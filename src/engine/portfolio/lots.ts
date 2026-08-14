import type { ISODate, Id } from "@/domain";
import {
  closesLotOn,
  deliversShares,
  isOptionLifecycleType,
  lotCloseValue,
  lotOpenValue,
  normalizeSymbol,
  opensLotOn,
  parseLotIds,
  type PositionSide,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";
import { resolveOptionPremiums } from "./optionPremiums";

/** Share counts below this are treated as fully depleted, not as a sliver of a
 *  lot left behind by floating-point division. */
const EPSILON = 1e-9;

/**
 * Every brokerage in this ledger prints share quantities to 5 decimal places.
 * A spinoff's child quantity is computed at full floating-point precision
 * (parent shares times a ratio like 1/3), so rounding it to that same
 * precision is what keeps it from drifting a few millionths of a share away
 * from the quantity the statement itself will print on the sale that later
 * closes it -- which would otherwise look like a (harmless but noisy) oversell.
 */
const SHARE_DECIMALS = 5;

function roundToShareDecimals(quantity: number): number {
  return Math.round(quantity * 10 ** SHARE_DECIMALS) / 10 ** SHARE_DECIMALS;
}

export interface OpenLot {
  /** The statement's lot id when it gave one, else the opening transaction's id. */
  id: string;
  accountId: Id;
  symbol: string;
  side: PositionSide;
  acquiredDate: ISODate;
  /** Shares still held (long) or still owed (short). Always positive. */
  quantity: number;
  /** Cost of the shares still held, or proceeds still owed against, per side. */
  costBasis: number;
  openTxId: Id;
}

export type HoldingTerm = "short" | "long";

export interface ClosedLot {
  id: string;
  accountId: Id;
  symbol: string;
  side: PositionSide;
  acquiredDate: ISODate;
  disposedDate: ISODate;
  quantity: number;
  /** What opening these shares cost (long) or brought in (short). */
  costBasis: number;
  /** What closing them brought in (long) or cost (short). */
  proceeds: number;
  gain: number;
  term: HoldingTerm;
  /**
   * False for shares moved out to another account. They deplete the lot but
   * realize nothing, and counting their zero proceeds as a total loss would
   * corrupt every realized-gain figure downstream.
   */
  taxable: boolean;
  /**
   * Why an untaxed disposal realized nothing, so the UI can say which it was
   * rather than calling every one of them a transfer. Absent when `taxable`.
   */
  untaxedReason?: "transfer" | "premium_absorbed" | "reorganization";
  /**
   * True when no open lot backed these shares and they were booked at zero
   * basis. Callers that trace a disposal back to its acquisition have to skip
   * these -- the "lot" they name never existed.
   */
  unmatched: boolean;
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
  if (opensLotOn(type)) return 0;
  if (type === "split" || type === "spinoff") return 1;
  if (closesLotOn(type)) return 2;
  // Retiring a contract comes after the ordinary closings so that a contract
  // sold and expired on the same date still draws down in that order.
  if (isOptionLifecycleType(type)) return 3;
  return 4;
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

function positionKey(accountId: Id, symbol: string, side: PositionSide): string {
  return `${accountId}::${symbol}::${side}`;
}

/**
 * Retires the contracts an expiry, exercise, or assignment closes out.
 *
 * The side is read from the book rather than from the transaction type: the
 * same event befalls a contract you bought and one you wrote, and asking the
 * user which it was would only invite the wrong answer.
 *
 * An expiry realizes the premium in full -- a long writes it off, a short keeps
 * it. Exercise and assignment realize nothing here, because the premium has
 * already been folded into the basis or proceeds of the shares that changed
 * hands; booking a gain on the contract as well would count it twice.
 */
function retireContracts(
  tx: Transaction,
  symbol: string,
  open: Map<string, OpenLot[]>,
  closedLots: ClosedLot[],
  warnings: LedgerWarning[],
): void {
  const longKey = positionKey(tx.accountId, symbol, "long");
  const shortKey = positionKey(tx.accountId, symbol, "short");
  const hasLong = (open.get(longKey) ?? []).some((lot) => lot.quantity > EPSILON);
  const side: PositionSide = hasLong ? "long" : "short";
  const key = hasLong ? longKey : shortKey;
  const lots = open.get(key) ?? [];

  // A premium already absorbed into a stock leg must not be realized again, so
  // these disposals are recorded untaxed -- the same treatment a transfer gets.
  const realizes = !deliversShares(tx.type);
  const label = tx.type === "option_assign" ? "assigned" : tx.type === "option_exercise" ? "exercised" : "expired";

  let remaining = tx.quantity;
  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    if (lot.quantity <= EPSILON) continue;
    const taken = Math.min(lot.quantity, remaining);
    const openValue = (lot.costBasis / lot.quantity) * taken;

    closedLots.push({
      id: lot.id,
      accountId: tx.accountId,
      symbol,
      side,
      acquiredDate: lot.acquiredDate,
      disposedDate: tx.date,
      quantity: taken,
      costBasis: openValue,
      // Nothing is received for a contract that expires, and an exercised or
      // assigned one is settled through its stock leg instead.
      proceeds: 0,
      gain: realizes ? (side === "short" ? openValue : -openValue) : 0,
      term: holdingTerm(lot.acquiredDate, tx.date),
      taxable: realizes,
      untaxedReason: realizes ? undefined : "premium_absorbed",
      unmatched: false,
      openTxId: lot.openTxId,
      closeTxId: tx.id,
    });

    lot.quantity -= taken;
    lot.costBasis -= openValue;
    remaining -= taken;
  }

  if (remaining > EPSILON) {
    const amount = remaining.toLocaleString(undefined, { maximumFractionDigits: 4 });
    warnings.push({
      txId: tx.id,
      date: tx.date,
      symbol,
      message: `${amount} more contracts ${label} than the ledger holds open — the extra were ignored. Add the missing trade that opened them.`,
    });
  }

  open.set(
    key,
    lots.filter((lot) => lot.quantity > EPSILON),
  );
}

/**
 * Applies a spinoff, merger, or ticker exchange to every open long lot of
 * `symbol`.
 *
 * A real spinoff (`spinoffBasisRetained` between 0 and 1) never touches the
 * parent's share count -- Danaher shareholders kept every DHR share when
 * Veralto was carved out of it. Only the *basis* moves: each open lot hands
 * over the fraction the company's Form 8937 says goes to the new symbol, the
 * parent keeps the rest, and the new symbol opens with exactly that much
 * basis on the *same* acquired date -- basis and holding period both tack
 * from the original purchase, per the ordinary spinoff basis-allocation rule.
 *
 * A full exchange or reorganization -- the parent stops existing, e.g. GGPI
 * becoming PSNY -- is the boundary case of the same mechanic: basis retained
 * is 0, so every open lot closes out untaxed (a reorganization realizes
 * nothing) and the new symbol opens at the full basis and the same date,
 * scaled by the share ratio.
 *
 * Only long lots are handled -- a corporate action retiring a short position
 * is not a case any statement in this ledger has needed yet.
 */
function applySpinoff(
  tx: Transaction,
  symbol: string,
  open: Map<string, OpenLot[]>,
  closedLots: ClosedLot[],
  warnings: LedgerWarning[],
): void {
  const newSymbol = tx.spinoffSymbol ? normalizeSymbol(tx.spinoffSymbol) : null;
  const ratio = tx.spinoffShareRatio;
  const retained = tx.spinoffBasisRetained;

  if (!newSymbol || ratio === null || ratio <= 0 || retained === null || retained < 0 || retained > 1) {
    warnings.push({
      txId: tx.id,
      date: tx.date,
      symbol,
      message:
        "Spinoff ignored: it needs a new symbol, a positive share ratio, and a basis-retained fraction between 0 and 1.",
    });
    return;
  }

  const key = positionKey(tx.accountId, symbol, "long");
  const lots = open.get(key) ?? [];
  const openLots = lots.filter((lot) => lot.quantity > EPSILON);
  if (openLots.length === 0) {
    warnings.push({
      txId: tx.id,
      date: tx.date,
      symbol,
      message: `Spinoff into ${newSymbol} ignored: no open ${symbol} position on this date to apply it to.`,
    });
    return;
  }

  const childKey = positionKey(tx.accountId, newSymbol, "long");
  const childLots = open.get(childKey) ?? [];
  if (!open.has(childKey)) open.set(childKey, childLots);

  const retires = retained <= 0;
  for (const lot of openLots) {
    const childBasis = lot.costBasis * (1 - retained);
    const childQuantity = roundToShareDecimals(lot.quantity * ratio);

    childLots.push({
      id: `${tx.id}-${lot.id}`,
      accountId: tx.accountId,
      symbol: newSymbol,
      side: "long",
      acquiredDate: lot.acquiredDate,
      quantity: childQuantity,
      costBasis: childBasis,
      openTxId: tx.id,
    });

    if (retires) {
      closedLots.push({
        id: lot.id,
        accountId: tx.accountId,
        symbol,
        side: "long",
        acquiredDate: lot.acquiredDate,
        disposedDate: tx.date,
        quantity: lot.quantity,
        costBasis: lot.costBasis,
        proceeds: 0,
        gain: 0,
        term: holdingTerm(lot.acquiredDate, tx.date),
        taxable: false,
        untaxedReason: "reorganization",
        unmatched: false,
        openTxId: lot.openTxId,
        closeTxId: tx.id,
      });
      lot.quantity = 0;
      lot.costBasis = 0;
    } else {
      lot.costBasis -= childBasis;
    }
  }

  if (retires) {
    open.set(
      key,
      lots.filter((lot) => lot.quantity > EPSILON),
    );
  }
}

/**
 * Replays a transaction ledger into open and closed tax lots.
 *
 * Long and short lots are kept in separate queues, so a sell only ever draws
 * down shares you own and a cover only ever draws down shares you owe. Without
 * that split, opening a short would look identical to selling stock you never
 * bought.
 *
 * Disposals honor the lot ids a trade names, in the order it names them, which
 * keeps realized gains matching what the brokerage reported; a trade naming
 * none falls back to FIFO. Closing more shares than the ledger knows about is
 * recorded against a zero-basis lot and flagged -- an imported history that
 * starts mid-stream is normal, and dropping the trade entirely would understate
 * proceeds far more badly than an overstated gain does.
 */
export function buildLotLedger(transactions: readonly Transaction[]): LotLedger {
  const open = new Map<string, OpenLot[]>();
  const closedLots: ClosedLot[] = [];
  const warnings: LedgerWarning[] = [];
  // Every lot id handed out so far, to catch two lots answering to one name --
  // scoped per account, because a sale can only ever draw on the lots
  // `positionKey` puts it next to: its own account's queue for that symbol and
  // side. Two accounts naming a lot "VTI-1" are not competing for the same
  // shares, so there is nothing for either sale to confuse it with; keying
  // this globally was flagging accounts that could never collide.
  const issued = new Map<Id, Set<string>>();

  // Exercised and assigned contracts fold their premium into the shares they
  // deliver, so the stock legs need their adjustments resolved before replay.
  const { pairings, unpaired } = resolveOptionPremiums(transactions);
  for (const problem of unpaired) {
    warnings.push(problem);
  }

  for (const tx of sortForReplay(transactions)) {
    if (tx.symbol === null) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const openSide = opensLotOn(tx.type);
    const closeSide = closesLotOn(tx.type);
    const premium = pairings.get(tx.id);

    if (openSide) {
      if (tx.quantity <= 0) continue;
      const key = positionKey(tx.accountId, symbol, openSide);
      const lots = open.get(key) ?? [];
      if (!open.has(key)) open.set(key, lots);
      // A purchase names exactly one lot -- its own. If a statement crammed
      // several ids into the field, the first is the one being opened.
      const lotId = parseLotIds(tx.lotId)[0] ?? tx.id;
      const issuedHere = issued.get(tx.accountId) ?? new Set<string>();
      if (!issued.has(tx.accountId)) issued.set(tx.accountId, issuedHere);
      if (issuedHere.has(lotId)) {
        warnings.push({
          txId: tx.id,
          date: tx.date,
          symbol,
          message: `Lot id "${lotId}" is already in use by an earlier purchase in this account, so a sale naming it can't tell the two apart. Give this one a different id.`,
        });
      }
      issuedHere.add(lotId);
      lots.push({
        id: lotId,
        accountId: tx.accountId,
        symbol,
        side: openSide,
        acquiredDate: tx.acquiredDate ?? tx.date,
        quantity: tx.quantity,
        // Shares delivered by an exercise or assignment carry the contract's
        // premium into their cost, so the basis is the strike plus what the
        // option itself cost (or minus what it brought in).
        costBasis: lotOpenValue(tx) + (premium?.adjustment ?? 0),
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
      // Basis per lot is unchanged by a split; only the share count moves. A
      // split applies to a borrowed position exactly as it does to an owned one.
      for (const side of ["long", "short"] as const) {
        for (const lot of open.get(positionKey(tx.accountId, symbol, side)) ?? []) {
          lot.quantity *= ratio;
        }
      }
      continue;
    }

    if (tx.type === "spinoff") {
      applySpinoff(tx, symbol, open, closedLots, warnings);
      continue;
    }

    if (isOptionLifecycleType(tx.type)) {
      if (tx.quantity <= 0) continue;
      retireContracts(tx, symbol, open, closedLots, warnings);
      continue;
    }

    if (!closeSide) continue;
    if (tx.quantity <= 0) continue;

    const key = positionKey(tx.accountId, symbol, closeSide);
    const lots = open.get(key) ?? [];
    if (!open.has(key)) open.set(key, lots);

    let remaining = tx.quantity;
    // Shares called away by an assignment, or delivered into an exercised put,
    // fetch the strike plus the premium that came with the contract.
    const closeValue =
      tx.type === "transfer_out" ? 0 : lotCloseValue(tx) + (premium?.adjustment ?? 0);
    const perShareClose = closeValue / tx.quantity;

    // Specific identification when the trade named lots, oldest-first
    // otherwise. Lots are appended in replay order, which is already
    // date-ascending, so the array itself is the FIFO queue.
    const namedIds = parseLotIds(tx.lotId);
    const claimed = new Set<OpenLot>();
    const candidates: OpenLot[] = [];
    const missing: string[] = [];
    let namedShares = 0;

    for (const id of namedIds) {
      const matches = lots.filter((lot) => lot.id === id && lot.quantity > EPSILON);
      if (matches.length === 0) {
        missing.push(id);
        continue;
      }
      for (const lot of matches) {
        if (claimed.has(lot)) continue;
        claimed.add(lot);
        candidates.push(lot);
        namedShares += lot.quantity;
      }
    }
    // Anything the trade didn't name still queues up behind what it did. A lot
    // that comes up short is a bookkeeping error worth flagging, but the shares
    // did leave the account from somewhere, and drawing the rest from the next
    // oldest lot is far closer to the truth than booking it at zero basis.
    for (const lot of lots) {
      if (!claimed.has(lot)) candidates.push(lot);
    }

    if (missing.length > 0) {
      const names = missing.map((id) => `"${id}"`).join(", ");
      warnings.push({
        txId: tx.id,
        date: tx.date,
        symbol,
        message:
          missing.length === 1
            ? `Lot ${names} named by this trade isn't open — fell back to oldest-first.`
            : `Lots ${names} named by this trade aren't open — fell back to oldest-first.`,
      });
    } else if (namedIds.length > 0 && tx.quantity > namedShares + EPSILON) {
      const wanted = tx.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 });
      const had = namedShares.toLocaleString(undefined, { maximumFractionDigits: 4 });
      const names = namedIds.map((id) => `"${id}"`).join(", ");
      warnings.push({
        txId: tx.id,
        date: tx.date,
        symbol,
        message:
          namedIds.length === 1
            ? `Lot ${names} is oversold: this trade closes ${wanted} shares but only ${had} were open in that lot. The rest came from the next oldest lots — name another lot if that's wrong.`
            : `Lots ${names} are oversold: this trade closes ${wanted} shares but only ${had} were open across them. The rest came from the next oldest lots — name another lot if that's wrong.`,
      });
    }

    for (const lot of candidates) {
      if (remaining <= EPSILON) break;
      if (lot.quantity <= EPSILON) continue;
      const taken = Math.min(lot.quantity, remaining);
      const openValue = (lot.costBasis / lot.quantity) * taken;
      const close = perShareClose * taken;

      closedLots.push({
        id: lot.id,
        accountId: tx.accountId,
        symbol,
        side: closeSide,
        acquiredDate: lot.acquiredDate,
        disposedDate: tx.date,
        quantity: taken,
        costBasis: openValue,
        proceeds: close,
        // A short profits when it costs less to cover than it brought in, so
        // its gain runs the opposite way to a long's.
        gain: closeSide === "short" ? openValue - close : close - openValue,
        term: holdingTerm(lot.acquiredDate, tx.date),
        taxable: tx.type !== "transfer_out",
        untaxedReason: tx.type === "transfer_out" ? "transfer" : undefined,
        unmatched: false,
        openTxId: lot.openTxId,
        closeTxId: tx.id,
      });

      lot.quantity -= taken;
      lot.costBasis -= openValue;
      remaining -= taken;
    }

    if (remaining > EPSILON) {
      const close = perShareClose * remaining;
      closedLots.push({
        id: `${tx.id}-unmatched`,
        accountId: tx.accountId,
        symbol,
        side: closeSide,
        acquiredDate: tx.date,
        disposedDate: tx.date,
        quantity: remaining,
        costBasis: 0,
        proceeds: close,
        gain: closeSide === "short" ? -close : close,
        term: "short",
        taxable: tx.type !== "transfer_out",
        untaxedReason: tx.type === "transfer_out" ? "transfer" : undefined,
        unmatched: true,
        openTxId: tx.id,
        closeTxId: tx.id,
      });
      const amount = remaining.toLocaleString(undefined, { maximumFractionDigits: 4 });
      warnings.push({
        txId: tx.id,
        date: tx.date,
        symbol,
        message:
          closeSide === "short"
            ? `Covered ${amount} more shares than the ledger shows shorted — counted at zero basis. Add the missing short sale.`
            : `Sold ${amount} more shares than the ledger holds — counted at zero cost basis, so the gain is overstated. Add the missing purchase, or record it as "Sell short" if this opened a short position.`,
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
