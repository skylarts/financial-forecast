"use client";

import { useEffect, useState } from "react";
import { useSchwabStatus } from "./useSchwabStatus";

export interface SchwabAccountOption {
  hashValue: string;
  masked: string;
}

/**
 * The connected login's Schwab accounts, shared by everything that lists
 * them.
 *
 * Deduped at module scope for the same reason `useSchwabStatus` is: the fetch
 * panel and the accounts tab can both want this on the same mount -- the panel
 * to fill its own picker, the tab to offer linking -- and each fetching its own
 * copy would double the request without either one knowing about the other.
 */
let inFlight: Promise<SchwabAccountOption[] | null> | null = null;

function load(): Promise<SchwabAccountOption[] | null> {
  if (!inFlight) {
    inFlight = fetch("/api/schwab/accounts")
      .then((response) => (response.ok ? (response.json() as Promise<{ accounts?: SchwabAccountOption[] }>) : null))
      .then((body) => body?.accounts ?? null)
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Null while disconnected or still loading; an empty array is a real answer
 * (a connected login with no accounts Schwab will hand back).
 */
export function useSchwabAccounts(): SchwabAccountOption[] | null {
  const { status } = useSchwabStatus();
  const connected = status?.connected === true;
  const [accounts, setAccounts] = useState<SchwabAccountOption[] | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    load().then((value) => {
      if (active) setAccounts(value);
    });
    return () => {
      active = false;
    };
  }, [connected]);

  // Masked rather than cleared on disconnect: a stale fetch finishing after
  // the connection drops should not resurrect a list nobody can act on, and
  // this way there is nothing to reset when it reconnects either.
  return connected ? accounts : null;
}
