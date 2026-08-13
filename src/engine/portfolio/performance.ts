import type { ISODate, Id } from "@/domain";
import {
  contractMultiplier,
  normalizeSymbol,
  signedCashFlow,
  type Transaction,
} from "@/domain/portfolio";

export interface PricePoint {
  date: ISODate;
  close: number;
}

export interface PerformancePoint {
  date: ISODate;
  /**
   * What the account was worth at that day's close: positions plus the cash
   * beside them on an `account` basis, positions alone on a `securities` one.
   * See {@link PerformanceSeries.basis}.
   */
  value: number;
  /** Net money moved in from outside that day; negative is money out. */
  flow: number;
  /** Time-weighted growth of one dollar, 1 at the start of the window. */
  index: number;
}

export interface PerformanceSeries {
  points: PerformancePoint[];
  /**
   * Symbols *still held* at the window's close that the feed had no history
   * for, so their closing value is a guess carried forward from the last price
   * paid. The UI names them because that guess sits in the final number.
   *
   * A position the ledger already closed is deliberately not listed here even
   * when it leaned on the same fallback. Its cost and its proceeds are both
   * recorded facts, so the return it contributed is exact -- an expired option
   * is worth zero and the ledger says so. Only the shape of the line in
   * between is approximate, and naming every dead contract for that would bury
   * the cases where the *answer* is uncertain under years of noise.
   */
  approximated: string[];
  /**
   * Which portfolio the returns describe.
   *
   * `account` is the real one: securities plus the cash sitting beside them,
   * replayed from the ledger's own cash movements. A sale converts securities
   * into cash rather than shrinking the portfolio, so only money crossing the
   * account boundary counts as a flow, and idle cash shows up as the drag it is.
   *
   * `securities` is the fallback for a ledger that cannot say what its cash was
   * doing -- see {@link replayableCash}. It values positions alone, which
   * makes every purchase look like a contribution arriving and every sale like a
   * withdrawal leaving. That still chains into a defensible return, but a day
   * the ledger emptied out has no base left to measure the next one against.
   */
  basis: "account" | "securities";
}

/** Types whose share movement is a transfer of value, not a purchase. */
const TRANSFER_TYPES = new Set(["transfer_in", "transfer_out"]);

/**
 * How large a day's flow may be, relative to what was invested going into it,
 * before that day stops being a measurement. Applies on a `securities` basis
 * only, which is the one that cannot see the cash a sale left behind.
 *
 * A time-weighted return divides the day's earnings by the base it opened on,
 * which only says anything while that base is the larger of the two. Once more
 * money moves than was invested to begin with, the quotient is describing the
 * size of the trade rather than what the holdings did, so one is the ceiling:
 * the day's flow may not exceed the base it started from.
 *
 * This is a blunt instrument -- it discards whatever the holdings really did
 * that day -- and it is a symptom of the basis rather than a fix. On an
 * `account` basis the cash is in the denominator, the collapse never starts,
 * and the day is measured like any other.
 */
const FLOW_DOMINANCE = 1;

/**
 * Whether a ledger accounts for the money it spends, and the opening cash
 * balance it implies.
 *
 * Measured at each day's close rather than after every row, because the order
 * of transactions inside one date is arbitrary -- a rebalance's purchases are
 * routinely listed ahead of the sales that paid for them, which would read as
 * an overdraft that never happened.
 *
 * `floor` is the smallest opening balance consistent with never having spent
 * money the account did not hold. It is a deduction rather than a guess: an
 * account that bought $1,000 of stock before its first recorded deposit
 * demonstrably held $1,000 the ledger does not mention, and starting from zero
 * would carry that day at nothing and measure the next one against it. Seeding
 * the balance rather than fixing it up per day keeps the series a single
 * running total, which is what makes the window's opening value inheritable.
 */
function replayableCash(ordered: readonly Transaction[]): {
  solvent: boolean;
  floor: number;
} {
  let cash = 0;
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
  return { solvent: worstDeficit <= arrived, floor: worstDeficit };
}

/**
 * Running share count per symbol, by transaction.
 *
 * Deliberately simpler than the lot ledger: valuing a portfolio needs only how
 * many shares were held, not which lots they came from, and replaying the full
 * ledger for every day of a ten-year window would cost far more than it buys.
 * Shorts carry a negative count, which is exactly right for valuation -- a
 * short position is worth what covering it would cost, as a liability.
 */
function applyToShares(held: Map<string, number>, tx: Transaction): void {
  if (tx.symbol === null) return;
  const symbol = normalizeSymbol(tx.symbol);
  const current = held.get(symbol) ?? 0;

  switch (tx.type) {
    case "buy":
    case "reinvest":
    case "transfer_in":
    case "buy_to_cover":
      held.set(symbol, current + tx.quantity);
      break;
    case "sell":
    case "transfer_out":
      held.set(symbol, current - tx.quantity);
      break;
    case "short_sell":
      held.set(symbol, current - tx.quantity);
      break;
    case "split":
      // `quantity` is the ratio here, not a share count.
      if (tx.quantity > 0) held.set(symbol, current * tx.quantity);
      break;
    case "option_expire":
    case "option_exercise":
    case "option_assign":
      // Retires the contract from whichever side it was held on.
      held.set(symbol, current > 0 ? current - tx.quantity : current + tx.quantity);
      break;
    default:
      break;
  }
}

/**
 * Money entering the invested pool on a transaction, from the investor's side.
 *
 * This is the figure a time-weighted return has to strip out: adding money to a
 * portfolio isn't performance, and neither is taking it out. Buys are money in,
 * sales money out. A dividend paid in cash leaves the pool, so it counts as
 * money out -- which is what makes it show up as return rather than vanishing,
 * since the share price already dropped by it.
 *
 * Deposits, interest and account fees carry no symbol and never touch the
 * invested pool at all, so they are not flows here. Counting a deposit would
 * report cash sitting idle in the account as a drag on the investments.
 */
function flowFor(tx: Transaction, priceOn: (symbol: string) => number | null): number {
  if (tx.symbol === null) return 0;

  if (TRANSFER_TYPES.has(tx.type)) {
    // Shares arriving or leaving move value without moving cash, so the flow is
    // what they were worth on the day. Without this a transfer in reads as an
    // instant gain of the entire position.
    const symbol = normalizeSymbol(tx.symbol);
    const price = priceOn(symbol);
    if (price === null) return 0;
    const value = tx.quantity * price * contractMultiplier(symbol);
    return tx.type === "transfer_in" ? value : -value;
  }

  // Cash flow is signed from the account's side, so a buy reads negative there
  // and positive here: what leaves the cash balance is what enters the pool.
  return -signedCashFlow(tx);
}

/**
 * Money crossing the account's boundary on a transaction.
 *
 * The flow a time-weighted return has to strip out is the money the investor
 * put in or took out -- nothing else. Once cash is tracked alongside the
 * positions, a purchase stops qualifying: it swaps cash for securities and
 * leaves the account worth exactly what it was a moment earlier. So do sales,
 * and so does a dividend, which moves value out of the share price and into the
 * cash balance without a dollar entering or leaving.
 *
 * That leaves deposits, withdrawals, and securities carried in or out of the
 * account by a custodian transfer. Fees are deliberately not flows either: the
 * money genuinely left, and a return that quietly excused its own costs would
 * flatter every account that pays them.
 */
function externalFlowFor(tx: Transaction, priceOn: (symbol: string) => number | null): number {
  if (TRANSFER_TYPES.has(tx.type)) {
    if (tx.symbol === null) return 0;
    const symbol = normalizeSymbol(tx.symbol);
    const price = priceOn(symbol);
    if (price === null) return 0;
    const value = tx.quantity * price * contractMultiplier(symbol);
    return tx.type === "transfer_in" ? value : -value;
  }
  if (tx.type === "cash_deposit" || tx.type === "cash_withdrawal") return signedCashFlow(tx);
  return 0;
}

/**
 * The close on the given day, or the last one before it.
 *
 * Binary search rather than a walk from the front, because this is the hot
 * path of the whole series: it runs once per held symbol per day, and the
 * arrays are years of daily closes. Scanning them was quadratic in the size of
 * the window -- a five-year chart over a wide ledger spent seconds inside this
 * function alone, on the main thread, before anything could be drawn.
 *
 * Requires `points` sorted ascending by date, which is how the feed builds
 * them.
 */
function lastOnOrBefore(points: readonly PricePoint[], date: ISODate): number | null {
  let low = 0;
  let high = points.length - 1;
  let answer: number | null = null;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (points[mid].date <= date) {
      answer = points[mid].close;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

/**
 * Every date the series should carry a point for: the trading days the feed
 * knows about, which is the only calendar that has prices attached.
 */
function tradingDays(
  histories: ReadonlyMap<string, readonly PricePoint[]>,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  const days = new Set<ISODate>();
  for (const points of histories.values()) {
    for (const point of points) {
      if (point.date >= from && point.date <= to) days.add(point.date);
    }
  }
  return [...days].sort();
}

/**
 * The symbols a window actually needs prices for.
 *
 * Asking for every symbol the ledger ever touched is what broke this: a few
 * years of option contracts is easily a hundred dead tickers, all of them
 * needing a request the feed will never answer, and all of them competing for
 * room in a capped list that was sorted alphabetically. A position closed years
 * before the window has no bearing on it, and neither does a contract that
 * expired long ago.
 *
 * Needed means either still held going into the window, or traded during it.
 */
export function symbolsForWindow(
  transactions: readonly Transaction[],
  from: ISODate,
  to: ISODate,
  accountIds?: readonly Id[],
): string[] {
  const scoped = accountIds
    ? transactions.filter((tx) => accountIds.includes(tx.accountId))
    : transactions;
  const ordered = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const needed = new Set<string>();
  const openingPosition = new Map<string, number>();
  const closingPosition = new Map<string, number>();

  for (const tx of ordered) {
    if (tx.date > to) break;
    if (tx.symbol === null) continue;

    if (tx.date < from) {
      // Still building the position the window opens on.
      applyToShares(openingPosition, tx);
    } else {
      // Traded inside the window, so it matters whichever way it moved.
      needed.add(normalizeSymbol(tx.symbol));
    }
    applyToShares(closingPosition, tx);
  }

  // Whatever was still on the books when the window opened has to be valued
  // through it, even if it was never traded again.
  for (const [symbol, shares] of openingPosition) {
    if (Math.abs(shares) > 1e-9) needed.add(symbol);
  }

  // Still-open positions lead, because the caller's list is a priority order
  // against a capped request and these are the ones that decide the closing
  // figure. Sorting the whole list alphabetically instead is what let a ledger
  // wide enough to overflow the cap drop every holding past the cut-off and
  // price them at the last figure paid -- the same failure the benchmarks were
  // already pulled to the front to escape.
  const stillHeld = (symbol: string) => Math.abs(closingPosition.get(symbol) ?? 0) > 1e-9;
  const all = [...needed].sort();
  return [...all.filter(stillHeld), ...all.filter((s) => !stillHeld(s))];
}

export interface SeriesOptions {
  from: ISODate;
  to: ISODate;
  /** Narrows to one or more accounts; omit for everything. */
  accountIds?: readonly Id[];
}

/**
 * Replays the ledger against daily closes into a time-weighted return series.
 *
 * Time-weighted rather than money-weighted because this is the figure that gets
 * compared to an index. A money-weighted return answers "how did my money do",
 * which depends on when you happened to add to the account -- so a good year
 * you didn't have much invested for counts for little. Against a benchmark that
 * is unfair in both directions: the only honest comparison strips contribution
 * timing out entirely, which is what chaining daily returns does.
 *
 * The portfolio is the account: positions plus cash. A stored cash balance is
 * only ever a snapshot, but the ledger is the history behind it -- replaying
 * its own money movements says what cash was sitting there on any past day
 * without inventing a figure. That matters beyond tidiness, because valuing
 * securities alone makes a portfolio that sold everything look like a portfolio
 * worth nothing, and the next purchase then divides a full position by the
 * float dust the sale left behind.
 *
 * A ledger that does not account for the money it spends cannot support that,
 * so it falls back to valuing positions alone. See {@link PerformanceSeries.basis}.
 */
export function buildPerformanceSeries(
  transactions: readonly Transaction[],
  histories: ReadonlyMap<string, readonly PricePoint[]>,
  options: SeriesOptions,
): PerformanceSeries {
  const { from, to, accountIds } = options;
  const scoped = accountIds
    ? transactions.filter((tx) => accountIds.includes(tx.accountId))
    : [...transactions];
  const ordered = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const days = tradingDays(histories, from, to);
  const relevant = ordered.filter((tx) => tx.date <= to);
  const funding = replayableCash(relevant);
  const basis: "account" | "securities" = funding.solvent ? "account" : "securities";
  if (days.length === 0) return { points: [], approximated: [], basis };

  /** Flat fallback for a symbol the feed has nothing for. */
  const fallbackPrice = new Map<string, number>();
  for (const tx of ordered) {
    if (tx.symbol === null || tx.price <= 0) continue;
    fallbackPrice.set(normalizeSymbol(tx.symbol), tx.price);
  }

  const usedFallback = new Set<string>();
  const priceOn = (symbol: string, date: ISODate): number | null => {
    const points = histories.get(symbol);
    const close = points ? lastOnOrBefore(points, date) : null;
    if (close !== null) return close;
    const fallback = fallbackPrice.get(symbol);
    if (fallback === undefined) return null;
    usedFallback.add(symbol);
    return fallback;
  };

  const held = new Map<string, number>();
  let cash = funding.floor;
  let cursor = 0;

  // Everything before the window opens is history: replay it so the window
  // starts from the position and the cash actually held, not from an empty
  // portfolio. The opening balance is the whole point of replaying it -- a
  // window that begins mid-ledger inherits both sides of what came before.
  while (cursor < ordered.length && ordered[cursor].date < from) {
    applyToShares(held, ordered[cursor]);
    cash += signedCashFlow(ordered[cursor]);
    cursor += 1;
  }

  const valueOn = (date: ISODate): number => {
    let total = 0;
    for (const [symbol, shares] of held) {
      if (shares === 0) continue;
      const price = priceOn(symbol, date);
      if (price === null) continue;
      total += shares * price * contractMultiplier(symbol);
    }
    return basis === "account" ? total + cash : total;
  };

  const points: PerformancePoint[] = [];
  let index = 1;
  let previousValue = valueOn(days[0]);

  for (const day of days) {
    let flow = 0;
    while (cursor < ordered.length && ordered[cursor].date <= day) {
      const tx = ordered[cursor];
      const on = (symbol: string) => priceOn(symbol, day);
      flow += basis === "account" ? externalFlowFor(tx, on) : flowFor(tx, on);
      applyToShares(held, tx);
      cash += signedCashFlow(tx);
      cursor += 1;
    }

    const value = valueOn(day);

    // The return the account earned, with the day's contributions and
    // withdrawals taken back out. A day that opened with nothing has no return
    // to measure -- money arriving is not performance -- so the index holds flat
    // rather than reporting the first deposit as an infinite gain.
    //
    // A position also cannot lose more than all of itself in a day, so a factor
    // at or below zero is a valuation failure rather than a return: the feed
    // could not price something and it fell back to the last figure paid.
    //
    // On a securities basis the base can also be merely negligible rather than
    // empty, because a ledger that sold out entirely reads as near-zero even
    // though the cash is sitting right there waiting to be redeployed. Buying
    // back in weeks later then divides a full position by the float dust the
    // sale left behind, and one such day permanently rescales every day after
    // it. Neutralising the day is a blunt guard -- it throws away whatever the
    // holdings really did -- and it is needed only because that basis cannot
    // see the cash. Tracking the cash removes the collapse at its source, so
    // the guard does not apply there: a deposit larger than the account is
    // ordinary early on, and it arrives in the value as well as the flow.
    const measurable =
      basis === "account" || Math.abs(flow) <= previousValue * FLOW_DOMINANCE;
    if (previousValue > 0 && measurable) {
      const factor = (value - flow) / previousValue;
      if (factor > 0) index *= factor;
    }

    points.push({ date: day, value, flow, index });
    previousValue = value;
  }

  // Only a fallback still propping up an open position leaves the answer
  // uncertain; one that merely coloured in a since-closed position does not.
  const approximated = [...usedFallback]
    .filter((symbol) => Math.abs(held.get(symbol) ?? 0) > 1e-9)
    .sort();

  return { points, approximated, basis };
}

/** Growth over the whole window, or null when there was nothing to measure. */
export function totalReturn(points: readonly PerformancePoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1].index;
  if (!Number.isFinite(last) || last <= 0) return null;
  return last / points[0].index - 1;
}

const DAYS_PER_YEAR = 365;

function spanYears(points: readonly PerformancePoint[]): number {
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);
  return (last - first) / 86_400_000 / DAYS_PER_YEAR;
}

/**
 * Annualized growth rate. Windows under a year are left un-annualized and
 * reported as-is: projecting a good month out to a yearly rate produces a
 * number that looks like a forecast and isn't one.
 */
export function annualizedReturn(points: readonly PerformancePoint[]): number | null {
  const total = totalReturn(points);
  if (total === null) return null;
  const years = spanYears(points);
  if (years < 1) return total;
  return Math.pow(1 + total, 1 / years) - 1;
}

export interface IndexedPoint {
  date: ISODate;
  index: number;
}

/**
 * A price history rebased so it starts at 1, which is what lets a benchmark sit
 * on the same axis as the portfolio. Two series at different price levels can
 * only be compared once both are expressed as growth.
 */
export function indexPrices(points: readonly PricePoint[], from: ISODate, to: ISODate): IndexedPoint[] {
  const window = points.filter((p) => p.date >= from && p.date <= to);
  const base = window[0]?.close;
  if (!base || base <= 0) return [];
  return window.map((p) => ({ date: p.date, index: p.close / base }));
}

/** Growth of a rebased series across the window. */
export function indexedReturn(points: readonly IndexedPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1].index / points[0].index - 1;
}
