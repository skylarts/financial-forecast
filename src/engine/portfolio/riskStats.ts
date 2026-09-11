import type { ISODate } from "@/domain";

/**
 * Risk and context figures read off an already-built time-weighted series.
 *
 * Everything here is one pass over points the engine already produced, per
 * window, the same way `totalReturn` is. Nothing touches the ledger, the lot
 * engine, or the caches. The functions take the narrowest shape they need, so
 * a benchmark's indexed price series fits them as well as the portfolio's.
 */

/** A day's place on a growth index; both the portfolio and a benchmark carry one. */
export interface IndexedDay {
  date: ISODate;
  index: number;
}

export interface Drawdown {
  /** Peak-to-trough decline as a negative fraction: -0.234 for a 23.4% fall. */
  depth: number;
  peak: ISODate;
  trough: ISODate;
  /** The first day the index regained its peak, or null while it hasn't. */
  recovered: ISODate | null;
}

/**
 * The deepest fall from any running high within the window.
 *
 * Walks the index once keeping the high-water mark. The trough is the lowest
 * point after the high, and recovery is the first later day back at or above
 * it. A window that only ever rose reports null: there was no drawdown, and
 * a 0% figure would read as a measurement rather than an absence.
 */
export function maxDrawdown(points: readonly IndexedDay[]): Drawdown | null {
  if (points.length < 2) return null;
  let peakIndex = points[0].index;
  let peakDate = points[0].date;
  let worst: Drawdown | null = null;
  let current: { peak: ISODate; trough: ISODate; depth: number } | null = null;

  for (const point of points) {
    if (point.index >= peakIndex) {
      // Back at a high: whatever drawdown was open has recovered here.
      if (current && (worst === null || current.depth < worst.depth)) {
        worst = { ...current, recovered: point.date };
      }
      current = null;
      peakIndex = point.index;
      peakDate = point.date;
      continue;
    }
    const depth = point.index / peakIndex - 1;
    if (current === null || depth < current.depth) {
      current = { peak: peakDate, trough: point.date, depth };
    }
  }
  // A drawdown still open at the window's end counts, unrecovered.
  if (current && (worst === null || current.depth < worst.depth)) {
    worst = { ...current, recovered: null };
  }
  return worst;
}

/** Trading days in a year, for annualizing a daily figure. */
const TRADING_DAYS = 252;

/**
 * Fewer daily returns than this and the figure is noise rather than a
 * measurement -- three weeks of moves annualized says nothing anyone should
 * act on.
 */
export const MIN_VOLATILITY_POINTS = 60;

/**
 * Annualized volatility: the standard deviation of daily log returns, scaled
 * by the square root of a trading year. Null on too short a window.
 */
export function volatility(points: readonly IndexedDay[]): number | null {
  if (points.length < MIN_VOLATILITY_POINTS) return null;
  const returns: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1].index;
    const next = points[i].index;
    if (previous > 0 && next > 0) returns.push(Math.log(next / previous));
  }
  if (returns.length < MIN_VOLATILITY_POINTS - 1) return null;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

export interface NetFlows {
  /** Dollars that came in over the window, positive. */
  in: number;
  /** Dollars that went out over the window, positive. */
  out: number;
  net: number;
}

/** What the investor put in and took out across the window. */
export function netFlows(points: readonly { flow: number }[]): NetFlows {
  let inflow = 0;
  let outflow = 0;
  for (const point of points) {
    if (point.flow > 0) inflow += point.flow;
    else if (point.flow < 0) outflow -= point.flow;
  }
  return { in: inflow, out: outflow, net: inflow - outflow };
}

export type FlowGrain = "day" | "week" | "month";

/**
 * The grain the chart draws flows at, so a five-year window doesn't become a
 * picket fence of one-pixel bars: daily up to three months, weekly to a
 * year, monthly beyond.
 */
export function flowGrainFor(days: number): FlowGrain {
  if (days <= 93) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** The Monday of the week `date` falls in, as an ISO date. */
function weekStart(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Flows summed into buckets of the given grain, keyed by the first trading
 * day the bucket has a point for -- so a bar lands on a date the chart's
 * x-axis actually carries. Buckets with no flow are omitted.
 */
export function bucketFlows(
  points: readonly { date: ISODate; flow: number }[],
  grain: FlowGrain,
): { date: ISODate; flow: number }[] {
  const keyOf = (date: ISODate): string =>
    grain === "day" ? date : grain === "week" ? weekStart(date) : date.slice(0, 7);
  const buckets = new Map<string, { date: ISODate; flow: number }>();
  for (const point of points) {
    const key = keyOf(point.date);
    const bucket = buckets.get(key);
    if (bucket) bucket.flow += point.flow;
    else buckets.set(key, { date: point.date, flow: point.flow });
  }
  return [...buckets.values()].filter((b) => Math.abs(b.flow) >= 0.005);
}
