import type { ISODate } from "@/domain";
import { earliestCoveredDate, windowReturn, type PerformancePoint, type PricePoint } from "./performance";

/**
 * The four return figures on the summary card, read off one time-weighted
 * series.
 *
 * A time-weighted index is a running product of daily factors, so the ratio
 * between any two of its points is exactly what a fresh series for that
 * narrower window would report -- four figures for the price of one build.
 */
export interface SummaryReturns {
  ytd: number | null;
  oneYear: number | null;
  lifetime: number | null;
  lifetimeCagr: number | null;
}

/** The same day a year earlier, as an ISO date. */
export function isoYearBefore(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export function summaryReturns(
  points: readonly PerformancePoint[],
  histories: ReadonlyMap<string, readonly PricePoint[]>,
  to: ISODate,
): SummaryReturns {
  /** How far back the loaded closes reach. */
  const feedStart = earliestCoveredDate(histories);
  /**
   * How far back this portfolio reaches. Its own first point is covered by
   * definition -- it exists only because a loaded history reached that far.
   */
  const seriesStart = points[0]?.date ?? null;

  /**
   * What a fixed-lookback window is measured as covered against: the later of
   * the two starts.
   *
   * A window has to reach back that far in the *ledger* as well as in the
   * feed, or a six-month-old account reports its six months as a one-year
   * return. Year-to-date deliberately doesn't use this -- an account opened
   * in March has no January, but the return since March genuinely is its
   * year to date.
   */
  const lookbackStart =
    feedStart === null || seriesStart === null ? null : feedStart > seriesStart ? feedStart : seriesStart;

  const lifetime = windowReturn(points, seriesStart ?? to, to, seriesStart);
  return {
    ytd: windowReturn(points, `${to.slice(0, 4)}-01-01`, to, feedStart).total,
    oneYear: windowReturn(points, isoYearBefore(to), to, lookbackStart).total,
    lifetime: lifetime.total,
    lifetimeCagr: lifetime.annualized,
  };
}
