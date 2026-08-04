"use client";

import { useMemo, useState } from "react";
import type { Account, ProjectionWarning } from "@/domain";

const KIND_LABELS: Record<ProjectionWarning["kind"], string> = {
  insufficient_funds: "Insufficient funds",
  unlinked_mortgage: "Unlinked mortgage",
  routing_conflict: "Conflicting routing rules",
  early_withdrawal_penalty: "Early-withdrawal penalty (pre-59½)",
  unamortized_debt: "Debt with no payoff plan",
  account_depleted: "Fully spent down",
};

// Running an account to $0 is often the PLAN (spending down a 529), so it
// reads as a neutral heads-up rather than sharing the red "something is wrong"
// banner with a genuine shortfall.
const INFO_KINDS = new Set<ProjectionWarning["kind"]>(["account_depleted"]);

export function WarningsBanner({ warnings, accounts }: { warnings: ProjectionWarning[]; accounts: Account[] }) {
  const [dismissed, setDismissed] = useState(false);
  const accountName = (id?: string) => accounts.find((a) => a.id === id)?.name;

  const grouped = useMemo(() => {
    const map = new Map<string, { kind: ProjectionWarning["kind"]; accountId?: string; firstYear: number; count: number }>();
    for (const w of warnings) {
      const key = `${w.kind}:${w.accountId ?? ""}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        existing.firstYear = Math.min(existing.firstYear, w.year);
      } else {
        map.set(key, { kind: w.kind, accountId: w.accountId, firstYear: w.year, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => a.firstYear - b.firstYear);
  }, [warnings]);

  if (grouped.length === 0 || dismissed) return null;

  const issues = grouped.filter((g) => !INFO_KINDS.has(g.kind));
  const notes = grouped.filter((g) => INFO_KINDS.has(g.kind));

  const line = (g: (typeof grouped)[number], i: number) => (
    <li key={i}>
      {KIND_LABELS[g.kind]}
      {accountName(g.accountId) ? ` — ${accountName(g.accountId)}` : ""}: starting {g.firstYear}
      {g.count > 1 ? ` (${g.count} occurrences in range)` : ""}
    </li>
  );

  return (
    <div className="flex flex-col gap-2">
      {issues.length > 0 && (
        <div className="rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">
              {issues.length === 1 ? "1 issue" : `${issues.length} issues`} in this projection
            </span>
            <button type="button" onClick={() => setDismissed(true)} className="text-xs opacity-70 hover:opacity-100">
              Dismiss
            </button>
          </div>
          <ul className="flex flex-col gap-0.5">{issues.map(line)}</ul>
        </div>
      )}
      {notes.length > 0 && (
        <div className="rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-dim">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">
              {notes.length === 1 ? "1 account is fully spent down" : `${notes.length} accounts are fully spent down`}
            </span>
            {issues.length === 0 && (
              <button type="button" onClick={() => setDismissed(true)} className="text-xs opacity-70 hover:opacity-100">
                Dismiss
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-0.5">
            {notes.map((g, i) => (
              <li key={i}>
                {accountName(g.accountId) ?? KIND_LABELS[g.kind]} hits $0 in {g.firstYear} — whatever it was still funding
                comes from the next account in your withdrawal routing.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
