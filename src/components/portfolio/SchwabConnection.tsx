"use client";

import { useSearchParams } from "next/navigation";
import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";

/**
 * What the callback reported, in words.
 *
 * The callback has always redirected back with a reason and nothing has ever
 * read it, so a brokerage sign-in that failed looked exactly like one that was
 * never attempted: back on the portfolio, no message, prices quietly still on
 * the public feed. Every outcome is spelled out here, because the useless
 * version of this feature is the one that fails without saying so.
 */
const OUTCOMES: Record<string, string> = {
  connected: "Schwab connected. Prices now come from your account.",
  denied: "Schwab sign-in was cancelled, so nothing changed.",
  failed:
    "Schwab signed you in but the connection could not be saved. If this app is signed in to a Supabase project, it needs SCHWAB_ENCRYPTION_KEY set and the schwab_connections table created.",
  state_mismatch:
    "That sign-in could not be matched to the one this app started, so it was refused. Starting again from this page usually clears it.",
  sign_in_required: "Sign in to this app first — a Schwab connection has to belong to an account.",
  unconfigured: "No Schwab app key is configured, so there is nothing to connect to.",
};

/** How close to expiry the banner starts asking for a re-login. */
const WARN_WITHIN_DAYS = 2;

/**
 * The callback's verdict, read straight from the address bar.
 *
 * Left in the URL rather than cleaned away: a message about a brokerage
 * sign-in that failed should survive a refresh, which is the first thing
 * anyone does when something did not work.
 */
function useCallbackOutcome(): string | null {
  const value = useSearchParams().get("schwab");
  if (!value) return null;
  return OUTCOMES[value] ?? `Schwab returned "${value}".`;
}

export function SchwabConnection() {
  const { status } = useSchwabStatus();
  const outcome = useCallbackOutcome();

  // The verdict outlives the banner's own conditions: a failed connection
  // leaves `connected` false, which is exactly the state that would otherwise
  // render as though nothing had been attempted.
  if (!status?.configured) return outcome ? <Notice>{outcome}</Notice> : null;

  const expiringSoon =
    status.connected &&
    status.daysRemaining !== null &&
    status.daysRemaining <= WARN_WITHIN_DAYS;

  if (status.connected && !expiringSoon) return outcome ? <Notice>{outcome}</Notice> : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-panel-2 px-6 py-2.5 text-[12.5px]">
      {outcome && <span className="w-full text-dim">{outcome}</span>}
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
      ) : status.signInRequired ? (
        <>
          <span className="text-dim">Using the public price feed</span>
          <span className="text-dim-2">
            — sign in to this app to use your Schwab connection. A brokerage connection belongs to
            an account, so there is nobody to attach it to until you do.
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
      {/* No Connect button while signed out: starting the flow would mint a
          credential with nowhere to put it, and failing at the end of a
          brokerage login is a poor way to learn that. */}
      {!status.signInRequired && (
        <a
          href="/api/schwab/authorize"
          className="rounded border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-accent"
        >
          {status.connected ? "Sign in again" : "Connect Schwab"}
        </a>
      )}
    </div>
  );
}

/** The verdict on its own, where the connection banner has nothing else to say. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border bg-panel-2 px-6 py-2.5 text-[12.5px] text-dim">
      {children}
    </div>
  );
}
