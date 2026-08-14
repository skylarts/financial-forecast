import type { ISODate, Id } from "@/domain";
import { signedCashFlow, type Portfolio, type Transaction } from "@/domain/portfolio";

/**
 * Uninvested cash, replayed from the ledger rather than stored.
 *
 * Every other figure in the tracker is derived from the transactions -- holdings,
 * lots, weights, returns -- and cash used to be the one exception: a number typed
 * on the Accounts tab that no trade, dividend, or deposit ever touched again. It
 * only stayed right for as long as the person who typed it kept retyping it, and
 * a balance nobody retyped drifted further from the truth with every row imported
 * after it. The performance chart, meanwhile, had always replayed cash from the
 * ledger, so the two views of the same account could and did disagree.
 *
 * This module is the one replay both of them now read.
 */

/** Cash on hand before the ledger's first row, when the account declares one. */
function openingOf(portfolio: Portfolio, accountId: Id): number {
  return portfolio.accounts.find((a) => a.id === accountId)?.openingCashBalance ?? 0;
}

export interface CashFunding {
  /**
   * Whether the ledger accounts for the money it spends. False means the cash
   * side is missing outright -- a file of trade confirmations with no funding
   * in it -- and any balance replayed from it would be fiction.
   */
  solvent: boolean;
  /**
   * The smallest opening balance consistent with never having spent money the
   * account did not hold, over and above whatever opening balance was declared.
   * Zero once the declared balance covers the ledger, which is the ordinary case.
   */
  floor: number;
}

/**
 * Whether a ledger accounts for the money it spends, and the extra opening cash
 * it implies beyond what the account declares.
 *
 * Measured at each day's close rather than after every row, because the order of
 * transactions inside one date is arbitrary -- a rebalance's purchases are
 * routinely listed ahead of the sales that paid for them, which would read as an
 * overdraft that never happened.
 *
 * `floor` is a deduction rather than a guess: an account that bought $1,000 of
 * stock before its first recorded deposit demonstrably held $1,000 the ledger
 * does not mention. It exists for partial ledgers -- an export that begins
 * mid-history -- and a complete one produces zero, leaving the declared opening
 * balance to stand on its own.
 */
export function replayableCash(
  ordered: readonly Transaction[],
  opening = 0,
): CashFunding {
  let cash = opening;
  let arrived = 0;
  let worstDeficit = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const tx = ordered[i];
    cash += signedCashFlow(tx);
    if (tx.type === "cash_deposit") arrived += Math.abs(signedCashFlow(tx));
    if (tx.type === "transfer_in") arrived += Math.abs(tx.quantity * tx.price);

    const endOfDay = i + 1 === ordered.length || ordered[i + 1].date !== tx.date;
    if (endOfDay && cash < -worstDeficit) worstDeficit = -cash;
  }

  if (worstDeficit === 0) return { solvent: true, floor: 0 };

  // A deficit on its own is not disqualifying, and is usually just dating:
  // settlement routinely stamps a purchase a day ahead of the transfer that
  // cleared for it, and a same-day rebalance lists its buys before its sells.
  // Seeding the balance absorbs all of that.
  //
  // What the seed cannot absorb is a ledger with no funding in it at all -- a
  // file of trade confirmations and no cash activity, where the implied opening
  // balance is not a settlement artifact but the entire cost of the portfolio.
  // The line is drawn where the deduction stops being modest: an account cannot
  // plausibly have opened holding more than every dollar the ledger can vouch
  // for having arrived, and one that records nothing arriving vouches for none.
  return { solvent: worstDeficit <= arrived + opening, floor: worstDeficit };
}

/** The ledger's own ordering for a cash replay: by date, input order within a day. */
function byDate(transactions: readonly Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface AccountCash {
  /** Cash on hand as of the date asked for. */
  balance: number;
  /** What the account declared it opened with. */
  opening: number;
  /** Extra opening cash the ledger implies but does not record. See {@link replayableCash}. */
  implied: number;
  /** False when the ledger has no cash side at all and the balance is a guess. */
  solvent: boolean;
}

/**
 * Cash on hand per account, replayed from every cash movement the ledger records.
 *
 * The seed is the account's declared opening balance plus whatever a partial
 * ledger implies on top of it, which is the same seed the performance chart
 * replays from -- so the balance shown on the Accounts tab is the one the chart's
 * closing point was built on, by construction rather than by coincidence.
 *
 * Transactions dated after `asOf` are left out, so an account can be read as of
 * any date without the future leaking backwards into it.
 */
export function accountCashBalances(
  portfolio: Portfolio,
  options: { asOf?: ISODate } = {},
): Map<Id, AccountCash> {
  const asOf = options.asOf;

  const byAccount = new Map<Id, Transaction[]>();
  for (const account of portfolio.accounts) byAccount.set(account.id, []);
  for (const tx of portfolio.transactions) byAccount.get(tx.accountId)?.push(tx);

  const balances = new Map<Id, AccountCash>();
  for (const account of portfolio.accounts) {
    const ordered = byDate(byAccount.get(account.id) ?? []);
    const opening = openingOf(portfolio, account.id);

    // The floor is read off the whole ledger, not the slice up to `asOf`: it is a
    // property of the account's history, and re-deriving it per as-of date would
    // let the seed shift under a window that merely ended earlier.
    const { solvent, floor } = replayableCash(ordered, opening);

    const moved = ordered
      .filter((tx) => asOf === undefined || tx.date <= asOf)
      .reduce((sum, tx) => sum + signedCashFlow(tx), 0);

    balances.set(account.id, {
      balance: opening + floor + moved,
      opening,
      implied: floor,
      solvent,
    });
  }

  return balances;
}
