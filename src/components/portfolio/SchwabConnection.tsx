"use client";

import { useCallback, useEffect, useState } from "react";

interface SchwabStatus {
  configured: boolean;
  connected: boolean;
  expiresAt: string | null;
  daysRemaining: number | null;
}

/** How close to expiry the banner starts asking for a re-login. */
const WARN_WITHIN_DAYS = 2;

/**
 * The state of the brokerage price connection, shown only when there is
 * something to do about it.
 *
 * Deliberately quiet. An install with no Schwab app configured renders nothing
 * at all and behaves exactly as it did before this existed, because the
 * brokerage feed is an enhancement over the public one rather than a
 * requirement -- prices, imports, and every other feature work without it.
 *
 * The one thing worth interrupting for is the expiry. Schwab's refresh token
 * dies seven days after it was issued and cannot be renewed without a human
 * logging in, so the connection lapses on a fixed clock no matter how well
 * everything is working. Prices quietly revert to the public feed when it does,
 * which is survivable but not something to discover by accident.
 */
export function SchwabConnection() {
  const [status, setStatus] = useState<SchwabStatus | null>(null);

  const load = useCallback(() => {
    fetch("/api/schwab/status")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: SchwabStatus | null) => setStatus(body))
      // A status check that fails is not worth surfacing: the feeds fall back
      // on their own and the banner has nothing useful to say about it.
      .catch(() => setStatus(null));
  }, []);

  useEffect(load, [load]);

  if (!status?.configured) return null;

  const expiringSoon =
    status.connected &&
    status.daysRemaining !== null &&
    status.daysRemaining <= WARN_WITHIN_DAYS;

  if (status.connected && !expiringSoon) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-panel-2 px-6 py-2.5 text-[12.5px]">
      {status.connected ? (
        <>
          <span className="text-dim">
            Schwab prices stop in{" "}
            {status.daysRemaining === 0 ? "less than a day" : `${status.daysRemaining} days`}
          </span>
          <span className="text-dim-2">
            — Schwab requires a fresh login every week. Prices fall back to the public feed until
            you sign in again.
          </span>
        </>
      ) : (
        <>
          <span className="text-dim">Using the public price feed</span>
          <span className="text-dim-2">
            — connect Schwab for your broker&apos;s own prices. Everything works either way.
          </span>
        </>
      )}
      <a
        href="/api/schwab/authorize"
        className="rounded border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-accent"
      >
        {status.connected ? "Sign in again" : "Connect Schwab"}
      </a>
    </div>
  );
}
