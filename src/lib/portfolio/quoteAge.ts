import type { ISODate } from "@/domain";

/**
 * Whether a quote is as fresh as it could be.
 *
 * A price is current if it comes from the last *completed* trading day or
 * later. Before today's close the newest price anyone can have is
 * yesterday's, so today is never the bar; over a weekend the bar is Friday,
 * and Friday's close is not stale on Sunday. Market holidays are not
 * modelled: a quote from the day before a holiday reads as a day old on the
 * day after it, which errs on the side of saying something rather than
 * nothing.
 */

function isoOf(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

/** The most recent weekday strictly before `today`, as an ISO date. */
export function lastCompletedTradingDay(today: ISODate): ISODate {
  const date = new Date(`${today}T00:00:00Z`);
  // 0 = Sunday, 1 = Monday, 6 = Saturday.
  const day = date.getUTCDay();
  const back = day === 0 ? 2 : day === 1 ? 3 : day === 6 ? 1 : 1;
  date.setUTCDate(date.getUTCDate() - back);
  return isoOf(date);
}

/**
 * True when a quote dated `quoteDate` predates the last completed trading
 * day -- the feed answered from an older session, or a cached price is being
 * served. An empty date (a manual price with no date) is never called stale:
 * there is nothing to measure it against, and the row already says it was
 * set by hand.
 */
export function isStaleQuote(quoteDate: ISODate | "" | null | undefined, today: ISODate): boolean {
  if (!quoteDate) return false;
  return quoteDate < lastCompletedTradingDay(today);
}

/** Whole calendar days between a quote's date and `today`. */
export function quoteAgeDays(quoteDate: ISODate, today: ISODate): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${quoteDate}T00:00:00Z`)) / 86_400_000,
  );
}
