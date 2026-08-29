"use client";

import { useEffect } from "react";
import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";
import { SchwabAppSettings } from "./SchwabAppSettings";

/**
 * The brokerage connection in one place, reachable at any time.
 *
 * It used to be a full-width banner under the header that stayed on screen
 * forever -- including when everything was fine, where all it held was one
 * collapsed link. The banner now speaks only when something needs doing; this
 * is where the connection is looked at on purpose.
 */
export function SchwabSettingsDialog({ onClose }: { onClose: () => void }) {
  const { status, reload } = useSchwabStatus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const days = status?.daysRemaining ?? null;
  const stalled = status?.connected && status.reachable === false;

  const summary = !status
    ? "Checking the connection…"
    : status.signInRequired
      ? "Sign in to this app first — a brokerage connection has to belong to an account."
      : stalled
        ? "Signed in, but Schwab is not answering right now. That is usually a temporary limit on their side and clears on its own; prices are on the public feed until it does."
        : status.connected
          ? `Connected. Prices come from your Schwab account, and the sign-in lasts ${
              days === null ? "under a week" : days === 0 ? "less than a day" : `${days} more day${days === 1 ? "" : "s"}`
            } — Schwab requires a fresh login every week.`
          : status.configured
            ? "Not connected. Prices are coming from the public feed until you sign in."
            : "No Schwab app registered yet. Schwab has no shared integration, so connecting means registering an app of your own.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Schwab connection"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-foreground">Schwab connection</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-dim hover:bg-panel-2 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4 text-[12.5px]">
          <p className="text-dim">{summary}</p>

          {status && !status.signInRequired && (
            <a
              href="/api/schwab/authorize"
              className="inline-block rounded border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-accent"
            >
              {status.connected ? "Sign in to Schwab again" : "Connect Schwab"}
            </a>
          )}

          {status && !status.signInRequired && <SchwabAppSettings onChanged={reload} alwaysOpen />}
        </div>
      </div>
    </div>
  );
}
