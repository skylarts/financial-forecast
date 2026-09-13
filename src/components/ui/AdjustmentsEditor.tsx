"use client";

import { useState } from "react";
import { nanoid } from "nanoid";
import type { TemporaryAdjustment } from "@/domain";
import { inputClass } from "./formFields";

/**
 * Editor for the temporary-adjustment windows on an income source or
 * expense -- a date range and a change in percent (+20 = a fifth more, −50 =
 * half, −100 = paused). Stored as a multiplier (1.2, 0.5, 0), like every
 * other rate in the plan; edited in percent, like every other rate box.
 */

/** The message for an adjustment row that can't be saved, or null when all rows are complete. */
export function adjustmentsIssue(adjustments: TemporaryAdjustment[], noun = "temporary adjustment"): string | null {
  for (let i = 0; i < adjustments.length; i++) {
    const a = adjustments[i];
    if (!a.startDate) return `The ${ordinal(i + 1)} ${noun} needs a start date.`;
    if (a.endDate && a.endDate < a.startDate) return `The ${ordinal(i + 1)} ${noun} ends before it starts.`;
    if (!Number.isFinite(a.multiplier) || a.multiplier < 0) return `The ${ordinal(i + 1)} ${noun} needs a change of −100% or more.`;
  }
  return null;
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
}

/** 1.2 -> "20", 0.5 -> "-50", 1 -> "" */
function multiplierToChangeStr(m: number): string {
  if (!Number.isFinite(m) || m === 1) return "";
  return String(Number(((m - 1) * 100).toFixed(4)));
}

export function AdjustmentsEditor({
  adjustments,
  onChange,
  helpText,
}: {
  adjustments: TemporaryAdjustment[];
  onChange: (next: TemporaryAdjustment[]) => void;
  helpText: string;
}) {
  // What each row's change box currently shows, so "-" or "1." can be typed
  // without the number snapping back mid-keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const update = (id: string, patch: Partial<TemporaryAdjustment>) =>
    onChange(adjustments.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const remove = (id: string) => onChange(adjustments.filter((a) => a.id !== id));
  const add = () => onChange([...adjustments, { id: nanoid(), startDate: "", endDate: null, multiplier: 1 }]);

  const setChange = (id: string, text: string) => {
    setDrafts((d) => ({ ...d, [id]: text }));
    const cleaned = text.replace(/%/g, "").trim();
    // Blank = no change (the row is harmless until a number is typed).
    if (cleaned === "") return update(id, { multiplier: 1 });
    const pct = Number(cleaned);
    if (!Number.isFinite(pct)) return;
    update(id, { multiplier: Math.max(0, 1 + pct / 100) });
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-dim">Temporary adjustments</div>
      <p className="mb-2 text-xs text-dim">
        {helpText} Overlapping windows multiply (two −50% cuts make −75%).
      </p>
      {adjustments.map((adj, i) => (
        <div key={adj.id} className="mb-2 flex flex-wrap items-end gap-2 rounded-md border border-border p-2 text-xs">
          <label className="flex flex-col gap-1 text-dim">
            From
            <input
              className={`${inputClass} w-auto`}
              type="date"
              value={adj.startDate}
              aria-label={`Adjustment ${i + 1} start date`}
              onChange={(e) => update(adj.id, { startDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-dim">
            To (optional)
            <input
              className={`${inputClass} w-auto`}
              type="date"
              value={adj.endDate ?? ""}
              aria-label={`Adjustment ${i + 1} end date`}
              onChange={(e) => update(adj.id, { endDate: e.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1 text-dim">
            Change
            <span className="relative block w-24">
              <input
                className={`${inputClass} pr-6`}
                type="text"
                inputMode="decimal"
                placeholder="e.g. -50"
                value={drafts[adj.id] ?? multiplierToChangeStr(adj.multiplier)}
                aria-label={`Adjustment ${i + 1} change in percent`}
                onChange={(e) => setChange(adj.id, e.target.value)}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-dim">%</span>
            </span>
          </label>
          <span className="pb-1.5 text-dim-2">
            {adj.multiplier === 0 ? "paused" : adj.multiplier === 1 ? "no change" : `×${Number(adj.multiplier.toFixed(4))}`}
          </span>
          <button type="button" onClick={() => remove(adj.id)} className="ml-auto pb-1.5 text-negative hover:underline">
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="text-xs text-accent hover:underline">
        + Add temporary adjustment
      </button>
    </div>
  );
}
