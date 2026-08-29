"use client";

import { useSyncExternalStore } from "react";

export interface SchwabStatus {
  /** This caller has an application to connect through -- their own, or the
   *  deployment's where the operator lends it out. */
  configured: boolean;
  /** A refresh token is on hand and has not aged out. */
  connected: boolean;
  /** Installed, but nobody is signed in -- the fix is a login, not a connect. */
  signInRequired: boolean;
  /** Whose Schwab application the connection runs through. */
  appSource: "user" | "deployment" | null;
  /**
   * Whether Schwab is answering right now, as opposed to whether a credential
   * is on file. Null when there is no connection to say anything about.
   */
  reachable: boolean | null;
  expiresAt: string | null;
  daysRemaining: number | null;
}

/**
 * The brokerage connection's state, as one value shared by everything that
 * displays it.
 *
 * This is a store rather than a hook with its own state because the page shows
 * the same fact in two places -- the standing badge in the header and the
 * banner that only speaks up when something needs doing -- and they were able
 * to disagree. Each consumer kept a private `useState` and fetched into it, so
 * the two held whatever the connection looked like at their own mount, and any
 * `reload()` updated only the component that called it. The visible result was
 * a header reading "● Schwab" above a banner reading "Using the public price
 * feed", on the same render, both believing themselves.
 *
 * One value, one fetch, every subscriber re-rendered together. Two components
 * showing the same thing can now only ever show the same thing.
 */
let current: SchwabStatus | null = null;
let requesting = false;
/**
 * Which request is allowed to write `current`.
 *
 * A reload issued after saving an app registration must not be overtaken by a
 * status check that was already on the wire when the save landed -- that older
 * answer describes the connection as it was before the change. Only the most
 * recently issued request may commit its result.
 */
let latestRequest = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function fetchStatus(): void {
  const request = ++latestRequest;
  requesting = true;

  void fetch("/api/schwab/status")
    .then((response) => (response.ok ? (response.json() as Promise<SchwabStatus>) : null))
    // A status check that fails is not worth surfacing on its own: the feeds
    // fall back without being told to, and there is nothing useful to say
    // about a request that didn't land. The last known answer stands rather
    // than being blanked, so a dropped poll doesn't flicker the header.
    .catch(() => null)
    .then((value) => {
      if (request !== latestRequest) return;
      requesting = false;
      if (value) {
        current = value;
        emit();
      }
    });
}

/** Fetches only if nothing is known and nothing is already on its way. */
function ensureLoaded(): void {
  if (current === null && !requesting) fetchStatus();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The first subscriber pulls. Later ones -- the second half of the header
  // mounting, or a dialog opening -- join the value that is already there
  // instead of putting a second request on the wire to answer the same
  // question.
  ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SchwabStatus | null {
  return current;
}

/** Nothing is known before the browser asks, and the server cannot ask. */
function getServerSnapshot(): SchwabStatus | null {
  return null;
}

export function useSchwabStatus(): { status: SchwabStatus | null; reload: () => void } {
  const status = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // `reload` is the module-level function itself: stable across renders
  // without a hook to make it so, and safe as a dependency anywhere.
  //
  // It re-reads for everyone rather than just its caller -- saving an app
  // registration changes what the badge should say as much as what the
  // settings form should, and those are different components. It is also
  // unconditional, unlike the mount-time pull: the caller knows something has
  // changed, so joining a request that predates the change would answer with
  // exactly the state it was told is stale.
  return { status, reload: fetchStatus };
}

/** Test seam: forgets the shared value between cases. */
export function resetSchwabStatusStore(): void {
  current = null;
  requesting = false;
  latestRequest = 0;
  listeners.clear();
}
