"use client";

import { useCallback, useEffect, useState } from "react";

export interface SchwabStatus {
  /** App key and secret are present -- the integration is installed. */
  configured: boolean;
  /** A refresh token is on hand and has not aged out. */
  connected: boolean;
  expiresAt: string | null;
  daysRemaining: number | null;
}

/**
 * The brokerage connection's state, shared by everything that displays it.
 *
 * Deduped at module scope because two separate parts of the header ask for
 * this on the same mount -- the persistent badge and the banner that only
 * appears when something needs doing. Letting each fetch its own copy would
 * put two requests on every page load to answer one question, and would let
 * them disagree with each other for a moment afterwards.
 */
let inFlight: Promise<SchwabStatus | null> | null = null;

function load(): Promise<SchwabStatus | null> {
  if (!inFlight) {
    inFlight = fetch("/api/schwab/status")
      .then((response) => (response.ok ? (response.json() as Promise<SchwabStatus>) : null))
      // A status check that fails is not worth surfacing on its own: the feeds
      // fall back without being told to, and there is nothing useful to say
      // about a request that didn't land.
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useSchwabStatus(): { status: SchwabStatus | null; reload: () => void } {
  const [status, setStatus] = useState<SchwabStatus | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    load().then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    load().then((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
    };
  }, []);

  return { status, reload };
}
