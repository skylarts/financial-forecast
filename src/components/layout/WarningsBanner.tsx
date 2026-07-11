"use client";

import { useMemo, useState } from "react";
import type { Account, ProjectionWarning } from "@/domain";

const KIND_LABELS: Record<ProjectionWarning["kind"], string> = {
  insufficient_funds: "Insufficient funds",
  unlinked_mortgage: "Unlinked mortgage",
  balance_update_required: "Balance update required",
  other: "Warning",
};

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

  return (
    <div className="rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">
          {grouped.length === 1 ? "1 issue" : `${grouped.length} issues`} in this projection
        </span>
        <button type="button" onClick={() => setDismissed(true)} className="text-xs opacity-70 hover:opacity-100">
          Dismiss
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {grouped.map((g, i) => (
          <li key={i}>
            {KIND_LABELS[g.kind]}
            {accountName(g.accountId) ? ` — ${accountName(g.accountId)}` : ""}: starting {g.firstYear}
            {g.count > 1 ? ` (${g.count} occurrences in range)` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
