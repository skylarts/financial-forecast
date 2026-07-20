"use client";

import { useEffect, useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Field, ErrorBanner, inputClass } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { addExistingHome, EXISTING_HOME_DEFAULTS, type ExistingHomeInput } from "@/lib/addExistingHome";

/**
 * Standalone version of the Setup Wizard's "home you already own" step --
 * lets you add an already-owned home (and its remaining mortgage, if any) at
 * any point after initial setup, not just during onboarding. A future
 * purchase belongs under Life Events -> Buy a Home instead; this is only for
 * a home you own as of today, so there's no purchase-price/down-payment
 * transaction, just the current value and (optionally) the loan already in
 * progress.
 */
export function ExistingHomeDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const planStartDate = usePlanStore((s) => s.activeScenario().settings.startDate);
  const [form, setForm] = useState<ExistingHomeInput>(EXISTING_HOME_DEFAULTS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EXISTING_HOME_DEFAULTS);
      setError(null);
    }
  }, [open]);

  const handleSubmit = () => {
    const result = addExistingHome(form, planStartDate);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title="Add a Home You Already Own">
      <div className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <p className="text-xs text-dim">
          Buying a home in the future? Use a &ldquo;Buy a home&rdquo; life event instead -- this is only for a home
          you own today.
        </p>
        <Field label="Current estimated value">
          <input
            className={inputClass}
            type="number"
            step="0.01"
            value={form.homeValue}
            onChange={(e) => setForm((f) => ({ ...f, homeValue: e.target.value }))}
          />
        </Field>
        <Field label="Annual appreciation rate (e.g. 0.03 for 3%)">
          <input
            className={inputClass}
            type="number"
            step="0.001"
            value={form.homeGrowthRatePct}
            onChange={(e) => setForm((f) => ({ ...f, homeGrowthRatePct: e.target.value }))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.hasMortgage}
            onChange={(e) => setForm((f) => ({ ...f, hasMortgage: e.target.checked }))}
          />
          Still have a mortgage on it
        </label>
        {form.hasMortgage && (
          <div className="flex flex-col gap-3 border-l border-border pl-3">
            <Field label="Remaining balance">
              <input
                className={inputClass}
                type="number"
                step="0.01"
                value={form.mortgageBalance}
                onChange={(e) => setForm((f) => ({ ...f, mortgageBalance: e.target.value }))}
              />
            </Field>
            <Field label="Interest rate (e.g. 0.065 for 6.5%)">
              <input
                className={inputClass}
                type="number"
                step="0.001"
                value={form.mortgageRate}
                onChange={(e) => setForm((f) => ({ ...f, mortgageRate: e.target.value }))}
              />
            </Field>
            <Field label="Years remaining">
              <input
                className={inputClass}
                type="number"
                step="1"
                min="1"
                value={form.mortgageYearsLeft}
                onChange={(e) => setForm((f) => ({ ...f, mortgageYearsLeft: e.target.value }))}
              />
            </Field>
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white">
            Add Home
          </button>
        </div>
      </div>
    </Drawer>
  );
}
