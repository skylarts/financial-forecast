"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";
import { SchwabAppSettings } from "./SchwabAppSettings";

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
  unconfigured:
    "There is no Schwab app to connect through yet. Register your own below — it takes a Schwab developer account and a day or two for approval.",
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
  const { status, reload } = useSchwabStatus();
  const outcome = useCallbackOutcome();

  if (!status) return null;

  // Nobody signed in on a deployment. There is no account to hang a brokerage
  // connection on, so the app settings are not offered either -- there would
  // be nowhere to store them.
  if (status.signInRequired) {
    return (
      <Bar
        outcome={outcome}
        headline="Using the public price feed"
        detail="Sign in to this app to use your Schwab connection. A brokerage connection belongs to an account, so there is nobody to attach it to until you do."
      />
    );
  }

  // Signed in, but this person has no Schwab application to connect through.
  // The normal state for a second user on a shared deployment, and the reason
  // the settings form exists: Schwab has no integration to be invited into,
  // so using this tool means registering an app of your own.
  if (!status.configured) {
    return (
      <Bar
        outcome={outcome}
        headline="Using the public price feed"
        detail="Connect your own Schwab app for your broker's own prices and transaction history. Everything works either way."
      >
        <SchwabAppSettings onChanged={reload} />
      </Bar>
    );
  }

  const expiringSoon =
    status.connected && status.daysRemaining !== null && status.daysRemaining <= WARN_WITHIN_DAYS;

  // Signed in to Schwab, but Schwab is not answering. Called out explicitly
  // because every other unhappy state here is fixed by the user doing
  // something, and this one is fixed by waiting -- offering a Connect button
  // would invite them to spend a Schwab login on a problem it cannot solve.
  if (status.connected && status.reachable === false) {
    return (
      <Bar
        outcome={outcome}
        headline="Schwab isn't answering right now"
        detail="Your connection is still signed in, so there is nothing to reconnect. This is usually a temporary limit on Schwab's side. Prices are on the public feed until it clears."
      />
    );
  }

  // Connected and healthy: nothing to report and nothing to do, so the banner
  // renders nothing at all. The standing badge in the header reports the
  // state, and the app registration lives behind the header's own menu -- a
  // permanent full-width strip holding one collapsed link was a row of chrome
  // paid for on every visit.
  if (status.connected && !expiringSoon) {
    if (!outcome) return null;
    return <Bar outcome={outcome} />;
  }

  return (
    <Bar
      outcome={outcome}
      headline={
        status.connected
          ? `Schwab prices stop in ${
              status.daysRemaining === 0 ? "less than a day" : `${status.daysRemaining} days`
            }`
          : "Using the public price feed"
      }
      detail={
        status.connected
          ? "Schwab requires a fresh login every week. Prices fall back to the public feed until you sign in again."
          : "Connect Schwab for your broker's own prices. Everything works either way."
      }
    >
      <a
        href="/api/schwab/authorize"
        className="rounded border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-accent"
      >
        {status.connected ? "Sign in again" : "Connect Schwab"}
      </a>
    </Bar>
  );
}

/**
 * One line of price-feed status, with the explanation folded behind it.
 *
 * The headline is the whole story for anyone who already knows what it means
 * -- "Using the public price feed" says which prices you are looking at, which
 * is the only part that has to be on screen. The paragraph underneath answers
 * "what does that mean and can I change it", which is a question you ask once
 * and then never again, but it was three lines of standing banner above every
 * tab, on every visit, forever.
 *
 * Actions stay out where they always were. Folding away a headline's
 * explanation is fine; folding away the button that fixes it is not.
 */
function Bar({
  outcome,
  headline,
  detail,
  children,
}: {
  /** What a just-finished sign-in attempt reported. Always shown: it is a
   *  reply to something the user just did, not standing background. */
  outcome?: string | null;
  headline?: React.ReactNode;
  /** The explanation behind the headline. Without one, the headline is plain
   *  text rather than a disclosure that opens onto nothing. */
  detail?: string;
  /** Buttons and links, beside the headline and never folded. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-panel p-3 text-[12.5px]">
      {outcome && <p className="mb-1.5 text-dim">{outcome}</p>}
      {(headline || children) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {headline &&
            (detail ? (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                title={open ? "Hide the explanation" : "What does this mean?"}
                className="flex items-center gap-1.5 text-left text-dim transition-colors hover:text-foreground"
              >
                {headline}
                <span
                  aria-hidden
                  className={`inline-block text-[9px] text-dim-2 transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
              </button>
            ) : (
              <span className="text-dim">{headline}</span>
            ))}
          {children}
        </div>
      )}
      {open && detail && <p className="mt-1.5 text-dim-2">{detail}</p>}
    </div>
  );
}
