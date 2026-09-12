"use client";

import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";
import { useAuth } from "@/components/auth/AuthProvider";
import { SchwabAppSettings } from "./SchwabAppSettings";
import { useModalDialog } from "@/components/ui/useModalDialog";

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

  const box = useModalDialog<HTMLDivElement>(onClose);
  const { signInWithGoogle } = useAuth();

  const days = status?.daysRemaining ?? null;
  const stalled = status?.connected && status.reachable === false;

  const summary = !status
    ? "Checking the connection…"
    : status.signInRequired
      ? "You're not signed in to this app yet. Connecting Schwab is a two-step thing: first sign in here with Google, so your Schwab connection has an account of your own to be stored under; then sign in to Schwab from this dialog."
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
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Schwab connection"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-foreground">Schwab connection</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-dim hover:bg-panel-2 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4 text-[12.5px]">
          <p className="text-dim">{summary}</p>

          {/* The one thing this dialog can do for someone signed out: the
              step they are missing, as a button, rather than a sentence
              pointing at a menu somewhere else. */}
          {status?.signInRequired && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="inline-block rounded border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-accent"
              >
                Sign in with Google
              </button>
              <p className="text-[11.5px] text-dim-2">
                This is the app&apos;s own sign-in, not Schwab&apos;s — the same one behind the ⋯ menu.
                Once you&apos;re in, reopen this dialog and the Connect Schwab button appears here.
                Nothing about your Schwab login is entered into this app; Schwab&apos;s own page
                handles that.
              </p>
            </div>
          )}

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
