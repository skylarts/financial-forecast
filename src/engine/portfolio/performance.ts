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
  /** Market value of the positions held at that day's close. */
  value: number;
  /** Net money moved into the invested pool that day; negative is money out. */
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
}

/** Types whose share movement is a transfer of value, not a purchase. */
const TRANSFER_TYPES = new Set(["transfer_in", "transfer_out"]);

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
 * The portfolio here is positions only. Account cash balances are a snapshot
 * with no history behind them, so there is no honest way to say what cash was
 * sitting there a year ago -- and guessing would put a made-up number into the
 * denominator of every return on the page.
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
  if (days.length === 0) return { points: [], approximated: [] };

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
  let cursor = 0;

  // Everything before the window opens is history: replay it so the window
  // starts from the position actually held, not from an empty portfolio.
  while (cursor < ordered.length && ordered[cursor].date < from) {
    applyToShares(held, ordered[cursor]);
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
    return total;
  };

  const points: PerformancePoint[] = [];
  let index = 1;
  let previousValue = valueOn(days[0]);

  for (const day of days) {
    let flow = 0;
    while (cursor < ordered.length && ordered[cursor].date <= day) {
      const tx = ordered[cursor];
      flow += flowFor(tx, (symbol) => priceOn(symbol, day));
      applyToShares(held, tx);
      cursor += 1;
    }

    const value = valueOn(day);

    // The return the investments earned, with the day's contributions and
    // withdrawals taken back out. A day that opened with nothing invested has
    // no return to measure -- money arriving is not performance -- so the index
    // holds flat rather than reporting the first purchase as an infinite gain.
    // A holding the feed could not price is carried at the last figure paid,
    // so on a ledger with many of those the day's flow can exceed everything
    // the book appears to be worth. That makes the factor negative, and a
    // negative factor does not represent a loss -- it flips the index's sign
    // and every later day compounds the wrong way, walking the curve off the
    // bottom of the chart. A position cannot lose more than all of itself in a
    // day, so a factor at or below zero is a valuation failure, not a return:
    // hold the index flat, exactly as a day that opened with nothing invested.
    if (previousValue > 0) {
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

  return { points, approximated };
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
