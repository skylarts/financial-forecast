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

const CENTS_PER_DOLLAR = 100;

/**
 * Rounds to the nearest cent, the smallest unit real money moves in.
 *
 * Summing signed cash flows across years of transactions accumulates ordinary
 * binary floating-point error -- a ledger that nets to exactly zero can drift
 * to something like -3e-11 well before its balance ever truly goes negative.
 * Left unrounded, that residue reads as a deficit, seeds a `floor` of a few
 * trillionths of a dollar, and a performance series that opens on cash alone
 * divides its first day's real return by that near-zero base -- which is how
 * a solvent account's chart came to open above a trillion dollars.
 */
function roundToCents(amount: number): number {
  return Math.round(amount * CENTS_PER_DOLLAR) / CENTS_PER_DOLLAR;
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
  /**
   * The deepest the balance went below zero at a day's close *after* the ledger
   * had recorded money arriving, and the day it happened on.
   *
   * Not seeded away, because by then it is a fact about the account rather than
   * a gap in the record: a margin balance, or a fee charged the day before the
   * sale that covered it. Reported so a caller can say so.
   */
  overdraft: number;
  overdraftOn: ISODate | null;
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
 * stock **before its first recorded deposit** demonstrably held $1,000 the
 * ledger does not mention. It exists for partial ledgers -- an export that
 * begins mid-history -- and a complete one produces zero, leaving the declared
 * opening balance to stand on its own.
 *
 * Once the ledger has watched money arrive, a later deficit is no longer
 * evidence about the opening balance, and seeding it is actively wrong: the
 * seed applies to every day in the account's history, so one afternoon's
 * overdraft in year five silently lifts the first year too. A real ledger hit
 * this -- $200 of transfer fees charged the day before the sale that covered
 * them put a Roth IRA $186.33 down for a single day, and all five years of it
 * then read $186.33 richer than the custodian's own statements. Those deficits
 * are reported through `overdraft` and left in the balance, where they belong:
 * a margin account is *supposed* to be able to go negative.
 */
export function replayableCash(
  ordered: readonly Transaction[],
  opening = 0,
): CashFunding {
  let cash = opening;
  let arrived = 0;
  /** Whether the ledger has recorded any money arriving yet. */
  let funded = false;
  /** Worst deficit while it had not -- the only kind that implies an opening balance. */
  let unfunded = 0;
  let overdraft = 0;
  let overdraftOn: ISODate | null = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const tx = ordered[i];
    cash = roundToCents(cash + signedCashFlow(tx));
    if (tx.type === "cash_deposit") {
      arrived += Math.abs(signedCashFlow(tx));
      funded = true;
    }
    if (tx.type === "transfer_in") {
      arrived += Math.abs(tx.quantity * tx.price);
      funded = true;
    }

    const endOfDay = i + 1 === ordered.length || ordered[i + 1].date !== tx.date;
    if (!endOfDay || cash >= 0) continue;
    if (funded) {
      if (-cash > overdraft) {
        overdraft = -cash;
        overdraftOn = tx.date;
      }
    } else if (-cash > unfunded) {
      unfunded = -cash;
    }
  }

  if (unfunded === 0) return { solvent: true, floor: 0, overdraft, overdraftOn };

  // What is left is a ledger that spent before it recorded anything arriving --
  // a file of trade confirmations and no cash activity, where the implied
  // opening balance is not a settlement artifact but the entire cost of the
  // portfolio. The line is drawn where the deduction stops being modest: an
  // account cannot plausibly have opened holding more than every dollar the
  // ledger can vouch for having arrived, and one that records nothing arriving
  // vouches for none.
  return {
    solvent: unfunded <= arrived + opening,
    floor: unfunded,
    overdraft,
    overdraftOn,
  };
}

/** The ledger's own ordering for a cash replay: by date, input order within a day. */
function byDate(transactions: readonly Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface AccountCash {
  /** Cash on hand as of the date asked for. Negative is allowed and is real. */
  balance: number;
  /** What the account declared it opened with. */
  opening: number;
  /** Extra opening cash the ledger implies but does not record. See {@link replayableCash}. */
  implied: number;
  /** False when the ledger has no cash side at all and the balance is a guess. */
  solvent: boolean;
  /** Deepest the balance went below zero after funding, and when. */
  overdraft: number;
  overdraftOn: ISODate | null;
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
    const { solvent, floor, overdraft, overdraftOn } = replayableCash(ordered, opening);

    const moved = ordered
      .filter((tx) => asOf === undefined || tx.date <= asOf)
      .reduce((sum, tx) => sum + signedCashFlow(tx), 0);

    balances.set(account.id, {
      balance: roundToCents(opening + floor + moved),
      opening,
      implied: floor,
      solvent,
      overdraft,
      overdraftOn,
    });
  }

  return balances;
}
