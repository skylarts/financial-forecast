"use client";

import { useState } from "react";
import type { Scenario } from "@/domain";
import { useAssumptionsStore } from "@/store/useAssumptionsStore";

const STALE_THRESHOLD_DAYS = 365;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Flags a plan whose Start Date has drifted more than a year behind the real
 * calendar -- every account's growth/contributions compound forward from
 * that date, so a stale one quietly makes the whole projection wrong (see
 * the Start Date field's own tooltip in AssumptionsDrawer). Deliberately NOT
 * persisted: "dismissed" is local component state, so it resets on every
 * reload rather than being snoozed for a year -- the point is to keep
 * surfacing this each session until it's actually fixed, not to nag
 * mid-session.
 */
export function StalePlanBanner({ scenario }: { scenario: Scenario }) {
  const [dismissed, setDismissed] = useState(false);
  // Lazy initializer, not a direct call in the render body -- React Compiler
  // flags Date.now() as impure otherwise. Computed once per mount, which is
  // exactly what's wanted here (a live "how stale is this" read on load).
  const [now] = useState(() => Date.now());
  const openAssumptions = useAssumptionsStore((s) => s.openAssumptions);

  const daysStale = Math.floor((now - new Date(scenario.settings.startDate).getTime()) / MS_PER_DAY);
  if (daysStale < STALE_THRESHOLD_DAYS || dismissed) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-foreground">
      <span>
        This plan&rsquo;s start date is over a year in the past — update it and each account&rsquo;s starting
        balance to keep the forecast accurate.
      </span>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={openAssumptions}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
        >
          Update now
        </button>
        <button type="button" onClick={() => setDismissed(true)} className="text-xs text-dim hover:text-foreground">
          Dismiss
        </button>
      </div>
    </div>
  );
}
