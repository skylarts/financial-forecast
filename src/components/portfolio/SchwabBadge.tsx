"use client";

import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";

/** How close to expiry the badge stops being reassuring and starts warning. */
const WARN_WITHIN_DAYS = 2;

function expiryWording(days: number): string {
  if (days === 0) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * A standing statement of which feed is pricing the portfolio.
 *
 * This exists because the banner beside it deliberately says nothing while the
 * connection is healthy, and silence turned out to be an unreadable signal:
 * "connected" and "the status check is broken" both render as nothing at all,
 * so there was no way to confirm a working brokerage login short of reading
 * the API by hand. A quiet always-on badge is the cheapest thing that can be
 * *believed* -- it distinguishes the two states without nagging about either.
 *
 * Renders nothing when no Schwab app is configured. An install that never
 * connects a brokerage has only ever had one feed, so naming it would be
 * describing a choice the user does not have.
 */
export function SchwabBadge() {
  const { status } = useSchwabStatus();
  if (!status?.configured) return null;

  const days = status.daysRemaining;
  const expiringSoon = status.connected && days !== null && days <= WARN_WITHIN_DAYS;

  const tone = !status.connected
    ? "text-dim-2"
    : expiringSoon
      ? "text-negative"
      : "text-positive";

  const title = status.connected
    ? `Prices are coming from your Schwab account. The sign-in expires in ${
        days === null ? "under a week" : expiryWording(days)
      }${status.expiresAt ? ` (${new Date(status.expiresAt).toLocaleDateString()})` : ""}, after which prices fall back to the public feed until you sign in again.`
    : "Prices are coming from the public feed. Connect Schwab to use your broker's own prices.";

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-dim"
    >
      <span aria-hidden className={tone}>
        {status.connected ? "●" : "○"}
      </span>
      {status.connected ? "Schwab" : "Public feed"}
      {/* The countdown appears only once it is close enough to act on. Showing
          "6 days" every day of the week would train it to be ignored by the
          time it said "1". */}
      {expiringSoon && (
        <span className="text-negative">· {days === 0 ? "today" : `${days}d`}</span>
      )}
    </span>
  );
}
