"use client";

import { useMemo, useState } from "react";
import type { Account, ProjectionWarning } from "@/domain";

const KIND_LABELS: Record<ProjectionWarning["kind"], string> = {
  insufficient_funds: "The plan runs out of money",
  unlinked_mortgage: "A mortgage has no home",
  routing_conflict: "A rule points at a missing account",
  early_withdrawal_penalty: "Early-withdrawal penalty (before 59½)",
  unamortized_debt: "A debt has no payoff plan",
  account_depleted: "Fully spent down",
};

// Running an account to $0 is often the PLAN (spending down a 529), so it
// reads as a neutral heads-up rather than sharing the red "something is wrong"
// banner with a genuine shortfall.
const INFO_KINDS = new Set<ProjectionWarning["kind"]>(["account_depleted"]);

/** "2061" or "2061–2072": the span of years a warning covers. */
function yearSpan(years: number[]): string {
  const first = Math.min(...years);
  const last = Math.max(...years);
  return first === last ? String(first) : `${first}–${last}`;
}

export function WarningsBanner({
  warnings,
  accounts,
  onOpenRouting,
}: {
  warnings: ProjectionWarning[];
  accounts: Account[];
  /** Opens the Routing tab, where a shortfall is usually fixed. */
  onOpenRouting?: () => void;
}) {
  const accountName = (id?: string) => accounts.find((a) => a.id === id)?.name;

  const grouped = useMemo(() => {
    const map = new Map<string, { kind: ProjectionWarning["kind"]; accountId?: string; years: number[]; message: string }>();
    for (const w of warnings) {
      const key = `${w.kind}:${w.accountId ?? ""}`;
      const existing = map.get(key);
      if (existing) existing.years.push(w.year);
      else map.set(key, { kind: w.kind, accountId: w.accountId, years: [w.year], message: w.message });
    }
    return [...map.values()].sort((a, b) => Math.min(...a.years) - Math.min(...b.years));
  }, [warnings]);

  // Dismissal is per set of warnings: an edit that newly runs the plan dry
  // shows up again instead of hiding behind an old Dismiss.
  const signature = grouped.map((g) => `${g.kind}:${g.accountId ?? ""}:${yearSpan(g.years)}`).join("|");
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const dismissed = dismissedSignature === signature;

  if (grouped.length === 0 || dismissed) return null;

  const issues = grouped.filter((g) => !INFO_KINDS.has(g.kind));
  const notes = grouped.filter((g) => INFO_KINDS.has(g.kind));

  return (
    <div className="flex flex-col gap-2">
      {issues.length > 0 && (
        <div className="rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">{issues.length === 1 ? "1 issue" : `${issues.length} issues`} in this projection</span>
            <button type="button" onClick={() => setDismissedSignature(signature)} className="text-xs opacity-70 hover:opacity-100">
              Dismiss
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            {issues.map((g, i) => (
              <li key={i}>
                <span className="font-medium">
                  {KIND_LABELS[g.kind]}
                  {accountName(g.accountId) ? ` — ${accountName(g.accountId)}` : ""}, {yearSpan(g.years)}.
                </span>{" "}
                <span className="opacity-90">{g.message}</span>
                {g.kind === "insufficient_funds" && onOpenRouting && (
                  <>
                    {" "}
                    <button type="button" onClick={onOpenRouting} className="underline hover:opacity-80">
                      Check the withdrawal strategy
                    </button>
                    .
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div className="rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-dim">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">
              {notes.length === 1 ? "1 account is fully spent down" : `${notes.length} accounts are fully spent down`}
            </span>
            {issues.length === 0 && (
              <button type="button" onClick={() => setDismissedSignature(signature)} className="text-xs opacity-70 hover:opacity-100">
                Dismiss
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-0.5">
            {notes.map((g, i) => (
              <li key={i}>
                {accountName(g.accountId) ?? KIND_LABELS[g.kind]} hits $0 in {Math.min(...g.years)} — whatever it was still funding comes
                from the next account in your withdrawal routing.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
