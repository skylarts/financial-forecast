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
   * Symbols carried at a flat fallback price because the feed had no history
   * for them -- delisted tickers and expired option contracts, mostly. They
   * hold their value steady rather than dropping to zero, and the UI names them
   * so a flat stretch is never mistaken for a real one.
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

function lastOnOrBefore(points: readonly PricePoint[], date: ISODate): number | null {
  let answer: number | null = null;
  for (const point of points) {
    if (point.date > date) break;
    answer = point.close;
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

  const approximated = new Set<string>();
  const priceOn = (symbol: string, date: ISODate): number | null => {
    const points = histories.get(symbol);
    const close = points ? lastOnOrBefore(points, date) : null;
    if (close !== null) return close;
    const fallback = fallbackPrice.get(symbol);
    if (fallback === undefined) return null;
    approximated.add(symbol);
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
    if (previousValue > 0) {
      index *= (value - flow) / previousValue;
    }

    points.push({ date: day, value, flow, index });
    previousValue = value;
  }

  return { points, approximated: [...approximated].sort() };
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
