"use client";

import { nanoid } from "nanoid";
import type { TemporaryAdjustment } from "@/domain";

/**
 * Editor for the temporary-adjustment windows on an income source or
 * expense -- replaces the old separate income_change / expense_change event
 * types. Each row is a date range + multiplier (0 = pause, 0.5 = half,
 * 1.03 = a one-off 3% bump).
 */
export function AdjustmentsEditor({
  adjustments,
  onChange,
  helpText,
}: {
  adjustments: TemporaryAdjustment[];
  onChange: (next: TemporaryAdjustment[]) => void;
  helpText: string;
}) {
  const update = (id: string, patch: Partial<TemporaryAdjustment>) =>
    onChange(adjustments.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const remove = (id: string) => onChange(adjustments.filter((a) => a.id !== id));
  const add = () =>
    onChange([...adjustments, { id: nanoid(), startDate: "", endDate: null, multiplier: 1 }]);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-dim">Temporary adjustments</div>
      <p className="mb-2 text-xs text-dim">{helpText}</p>
      {adjustments.map((adj) => (
        <div key={adj.id} className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
          <label className="flex flex-col gap-1 text-dim">
            From
            <input
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              type="date"
              value={adj.startDate}
              onChange={(e) => update(adj.id, { startDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-dim">
            To (optional)
            <input
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              type="date"
              value={adj.endDate ?? ""}
              onChange={(e) => update(adj.id, { endDate: e.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1 text-dim">
            Multiplier
            <input
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              type="number"
              step="0.05"
              min="0"
              value={adj.multiplier}
              onChange={(e) => update(adj.id, { multiplier: Number(e.target.value) })}
            />
          </label>
          <button type="button" onClick={() => remove(adj.id)} className="ml-auto self-end text-negative hover:underline">
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
