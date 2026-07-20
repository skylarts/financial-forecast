"use client";

import { useEffect, useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Field, ErrorBanner, inputClass } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { addExistingHome, EXISTING_HOME_DEFAULTS, type ExistingHomeInput } from "@/lib/addExistingHome";
import { computeMonthlyPayment } from "@/engine/amortization";

/**
 * Standalone version of the Setup Wizard's "home you already own" step --
 * lets you add an already-owned home (and its remaining mortgage, if any) at
 * any point after initial setup, not just during onboarding. A future
 * purchase belongs under Life Events -> Buy a Home instead; this is only for
 * a home you own as of today, so there's no purchase-price/down-payment
 * transaction, just the current value and (optionally) the loan already in
 * progress. Same ongoing-cost inputs (property tax, insurance, maintenance,
 * extra principal) as a Buy a Home event, for parity.
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

  // Live monthly-cost breakdown, same display aid as the Buy a Home event
  // drawer -- purely for feedback as you type; the engine recomputes
  // independently on save.
  const homeValue = Number(form.homeValue) || 0;
  const balance = form.hasMortgage ? Number(form.mortgageBalance) || 0 : 0;
  const rate = Number(form.mortgageRate) || 0;
  const termMonths = (Number(form.mortgageYearsLeft) || 0) * 12;
  const extra = form.hasMortgage ? Number(form.mortgageExtraPrincipal) || 0 : 0;
  const pAndI = form.hasMortgage && balance > 0 && termMonths > 0 ? computeMonthlyPayment(balance, rate, termMonths) : 0;
  const taxMonthly = (homeValue * (Number(form.propertyTaxRatePct) || 0)) / 12;
  const insuranceMonthly = (homeValue * (Number(form.homeInsuranceRatePct) || 0)) / 12;
  const maintenanceMonthly = (homeValue * (Number(form.maintenanceRatePct) || 0)) / 12;
  const monthlyTotal = pAndI + extra + taxMonthly + insuranceMonthly + maintenanceMonthly;
  const money0 = (n: number) => `$${Math.round(n).toLocaleString()}`;

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
        <Field label="Property Tax Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.01 = 1%. Grows with the home.">
          <input
            className={inputClass}
            type="number"
            step="0.001"
            placeholder="e.g. 0.01"
            value={form.propertyTaxRatePct}
            onChange={(e) => setForm((f) => ({ ...f, propertyTaxRatePct: e.target.value }))}
          />
        </Field>
        <Field label="Home Insurance Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.005 = 0.5%. Grows with the home.">
          <input
            className={inputClass}
            type="number"
            step="0.001"
            placeholder="e.g. 0.005"
            value={form.homeInsuranceRatePct}
            onChange={(e) => setForm((f) => ({ ...f, homeInsuranceRatePct: e.target.value }))}
          />
        </Field>
        <Field label="Maintenance Rate (per year, optional)" hint="Share of the home's value per year -- the classic '1% rule' upkeep estimate. Grows with the home.">
          <input
            className={inputClass}
            type="number"
            step="0.001"
            placeholder="e.g. 0.01"
            value={form.maintenanceRatePct}
            onChange={(e) => setForm((f) => ({ ...f, maintenanceRatePct: e.target.value }))}
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
            <Field
              label="Extra Principal / month (optional)"
              hint="Paid on top of the scheduled payment -- pays the loan off early."
            >
              <input
                className={inputClass}
                type="number"
                step="0.01"
                placeholder="e.g. 200"
                value={form.mortgageExtraPrincipal}
                onChange={(e) => setForm((f) => ({ ...f, mortgageExtraPrincipal: e.target.value }))}
              />
            </Field>
          </div>
        )}

        {homeValue > 0 && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-dim">Est. monthly cost</span>
              <span className="text-base font-semibold">{money0(monthlyTotal)}</span>
            </div>
            <div className="flex flex-col gap-1 text-xs text-dim">
              {form.hasMortgage && (
                <div className="flex justify-between">
                  <span>Principal &amp; interest</span>
                  <span>{money0(pAndI)}</span>
                </div>
              )}
              {extra > 0 && (
                <div className="flex justify-between">
                  <span>Extra principal</span>
                  <span>{money0(extra)}</span>
                </div>
              )}
              {taxMonthly > 0 && (
                <div className="flex justify-between">
                  <span>Property tax</span>
                  <span>{money0(taxMonthly)}</span>
                </div>
              )}
              {insuranceMonthly > 0 && (
                <div className="flex justify-between">
                  <span>Home insurance</span>
                  <span>{money0(insuranceMonthly)}</span>
                </div>
              )}
              {maintenanceMonthly > 0 && (
                <div className="flex justify-between">
                  <span>Maintenance</span>
                  <span>{money0(maintenanceMonthly)}</span>
                </div>
              )}
            </div>
            <p className="mt-2 text-[11px] text-dim">Today's dollars. Tax, insurance &amp; maintenance grow with the home's value.</p>
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
