"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, BuyHomeEvent } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { addExistingHome, updateExistingHome, removeExistingHome, EXISTING_HOME_DEFAULTS } from "@/lib/addExistingHome";
import { buyNewHome, updateBoughtHome, removeBoughtHome, BUY_HOME_DEFAULTS } from "@/lib/buyHome";
import { computeMonthlyPayment } from "@/engine/amortization";

type Mode = "existing" | "buy";

interface FormValues {
  name: string;
  startDate: string;
  value: string;
  growthRatePct: string;
  propertyTaxRatePct: string;
  homeInsuranceRatePct: string;
  maintenanceRatePct: string;
  hasMortgage: boolean;
  mortgageBalance: string;
  financed: boolean;
  downPaymentAmount: string;
  downPaymentFromAccountId: string;
  replaceHousingExpenses: boolean;
  mortgageRate: string;
  mortgageTermYears: string;
  mortgageExtraPrincipal: string;
}

function defaultsForMode(mode: Mode): FormValues {
  return mode === "existing"
    ? {
        name: "Home",
        startDate: "",
        value: "",
        growthRatePct: EXISTING_HOME_DEFAULTS.homeGrowthRatePct,
        propertyTaxRatePct: "",
        homeInsuranceRatePct: "",
        maintenanceRatePct: "",
        hasMortgage: false,
        mortgageBalance: "",
        financed: false,
        downPaymentAmount: "",
        downPaymentFromAccountId: "",
        replaceHousingExpenses: false,
        mortgageRate: EXISTING_HOME_DEFAULTS.mortgageRate,
        mortgageTermYears: EXISTING_HOME_DEFAULTS.mortgageYearsLeft,
        mortgageExtraPrincipal: "",
      }
    : {
        name: "",
        startDate: "",
        value: "",
        growthRatePct: BUY_HOME_DEFAULTS.propertyGrowthRatePct,
        propertyTaxRatePct: BUY_HOME_DEFAULTS.propertyTaxRatePct,
        homeInsuranceRatePct: BUY_HOME_DEFAULTS.homeInsuranceRatePct,
        maintenanceRatePct: BUY_HOME_DEFAULTS.maintenanceRatePct,
        hasMortgage: false,
        mortgageBalance: "",
        financed: true,
        downPaymentAmount: "",
        downPaymentFromAccountId: "",
        replaceHousingExpenses: false,
        mortgageRate: BUY_HOME_DEFAULTS.mortgageRate,
        mortgageTermYears: BUY_HOME_DEFAULTS.mortgageTermYears,
        mortgageExtraPrincipal: "",
      };
}

function toFormValues(mode: Mode, account?: Account, event?: BuyHomeEvent, mortgage?: Account): FormValues {
  if (!account) return defaultsForMode(mode);
  if (mode === "buy" && event) {
    return {
      name: event.name,
      startDate: event.startDate,
      value: event.purchasePrice.toString(),
      growthRatePct: (account.propertyGrowthRatePct ?? account.growthRatePct ?? 0).toString(),
      propertyTaxRatePct: account.propertyTaxRatePct?.toString() ?? "",
      homeInsuranceRatePct: account.homeInsuranceRatePct?.toString() ?? "",
      maintenanceRatePct: account.maintenanceRatePct?.toString() ?? "",
      hasMortgage: !!mortgage,
      mortgageBalance: "",
      financed: !!mortgage,
      downPaymentAmount: event.downPaymentAmount.toString(),
      downPaymentFromAccountId: event.downPaymentFromAccountId,
      replaceHousingExpenses: event.replaceHousingExpenses ?? false,
      mortgageRate: mortgage?.loanTerms?.annualInterestRatePct.toString() ?? BUY_HOME_DEFAULTS.mortgageRate,
      mortgageTermYears: mortgage ? Math.round(mortgage.loanTerms!.termMonths / 12).toString() : BUY_HOME_DEFAULTS.mortgageTermYears,
      mortgageExtraPrincipal: mortgage?.loanTerms?.extraPrincipalMonthly?.toString() ?? "",
    };
  }
  return {
    name: account.name,
    startDate: "",
    value: account.startingBalance.toString(),
    growthRatePct: (account.propertyGrowthRatePct ?? account.growthRatePct ?? 0).toString(),
    propertyTaxRatePct: account.propertyTaxRatePct?.toString() ?? "",
    homeInsuranceRatePct: account.homeInsuranceRatePct?.toString() ?? "",
    maintenanceRatePct: account.maintenanceRatePct?.toString() ?? "",
    hasMortgage: !!mortgage,
    mortgageBalance: mortgage?.startingBalance.toString() ?? "",
    financed: false,
    downPaymentAmount: "",
    downPaymentFromAccountId: "",
    replaceHousingExpenses: false,
    mortgageRate: mortgage?.loanTerms?.annualInterestRatePct.toString() ?? EXISTING_HOME_DEFAULTS.mortgageRate,
    mortgageTermYears: mortgage ? Math.round(mortgage.loanTerms!.termMonths / 12).toString() : EXISTING_HOME_DEFAULTS.mortgageYearsLeft,
    mortgageExtraPrincipal: mortgage?.loanTerms?.extraPrincipalMonthly?.toString() ?? "",
  };
}

/**
 * One drawer for every real-estate account: adding a home you already own,
 * buying one in the future (a life event), and editing either kind
 * afterward -- whether you open it from the Account tab's pencil or from a
 * Buy a Home event on the Timeline, it's the same form against the same
 * underlying account. See src/lib/addExistingHome.ts and src/lib/buyHome.ts
 * for the two create/update/remove paths this delegates to.
 */
export function HomeDrawer({
  open,
  onClose,
  account,
  event,
  accounts,
  initialMode = "existing",
}: {
  open: boolean;
  onClose: () => void;
  /** The real_estate account being edited; omitted when creating a new home. */
  account?: Account;
  /** The linked buy_home event, if this home was (or is being) bought rather than entered as already-owned. */
  event?: BuyHomeEvent;
  /** For the "Pay Down Payment From" dropdown. */
  accounts: Account[];
  /** Only consulted when account is omitted (creating new). */
  initialMode?: Mode;
}) {
  const settings = usePlanStore((s) => s.activeScenario().settings);
  const scenarioAccounts = usePlanStore((s) => s.activeScenario().accounts);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!account;
  const [mode, setMode] = useState<Mode>(event ? "buy" : initialMode);
  const mortgage = account?.linkedLiabilityId ? scenarioAccounts.find((a) => a.id === account.linkedLiabilityId) : undefined;

  const { register, handleSubmit, reset, watch, setValue } = useForm<FormValues>({
    defaultValues: toFormValues(mode, account, event, mortgage),
  });

  useEffect(() => {
    const nextMode: Mode = event ? "buy" : isEditing ? "existing" : initialMode;
    setMode(nextMode);
    reset(toFormValues(nextMode, account, event, mortgage));
    setError(null);
    // Only re-run when the drawer opens or the underlying record changes --
    // not on every keystroke of `mortgage`/`scenarioAccounts` re-derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, event, open, initialMode, reset]);

  const hasMortgage = watch("hasMortgage");
  const financed = watch("financed");
  const isFinanced = mode === "existing" ? hasMortgage : financed;

  // Live monthly-cost breakdown -- purely a display aid; the engine (or, for
  // a plain existing home, nothing at all) recomputes independently on save.
  const value = Number(watch("value")) || 0;
  const down = mode === "buy" && financed ? Number(watch("downPaymentAmount")) || 0 : 0;
  const principal = mode === "existing" ? Number(watch("mortgageBalance")) || 0 : Math.max(0, value - down);
  const rate = Number(watch("mortgageRate")) || 0;
  const termMonths = (Number(watch("mortgageTermYears")) || 0) * 12;
  const extra = isFinanced ? Number(watch("mortgageExtraPrincipal")) || 0 : 0;
  const pAndI = isFinanced && principal > 0 && termMonths > 0 ? computeMonthlyPayment(principal, rate, termMonths) : 0;
  const taxMonthly = (value * (Number(watch("propertyTaxRatePct")) || 0)) / 12;
  const insuranceMonthly = (value * (Number(watch("homeInsuranceRatePct")) || 0)) / 12;
  const maintenanceMonthly = (value * (Number(watch("maintenanceRatePct")) || 0)) / 12;
  const monthlyTotal = pAndI + extra + taxMonthly + insuranceMonthly + maintenanceMonthly;
  const money0 = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));

  const onSubmit = (v: FormValues) => {
    let result: { ok: true } | { ok: false; error: string };
    if (mode === "existing") {
      const input = {
        homeValue: v.value,
        homeGrowthRatePct: v.growthRatePct,
        propertyTaxRatePct: v.propertyTaxRatePct,
        homeInsuranceRatePct: v.homeInsuranceRatePct,
        maintenanceRatePct: v.maintenanceRatePct,
        hasMortgage: v.hasMortgage,
        mortgageBalance: v.mortgageBalance,
        mortgageRate: v.mortgageRate,
        mortgageYearsLeft: v.mortgageTermYears,
        mortgageExtraPrincipal: v.mortgageExtraPrincipal,
      };
      result = account
        ? updateExistingHome(account.id, input, settings.startDate)
        : addExistingHome(input, settings.startDate);
    } else {
      const input = {
        name: v.name,
        startDate: v.startDate,
        purchasePrice: v.value,
        financed: v.financed,
        downPaymentAmount: v.downPaymentAmount,
        downPaymentFromAccountId: v.downPaymentFromAccountId,
        mortgageRate: v.mortgageRate,
        mortgageTermYears: v.mortgageTermYears,
        mortgageExtraPrincipal: v.mortgageExtraPrincipal,
        propertyGrowthRatePct: v.growthRatePct,
        propertyTaxRatePct: v.propertyTaxRatePct,
        homeInsuranceRatePct: v.homeInsuranceRatePct,
        maintenanceRatePct: v.maintenanceRatePct,
        replaceHousingExpenses: v.replaceHousingExpenses,
      };
      result = event
        ? updateBoughtHome(event.id, input, settings)
        : buyNewHome(input, settings);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  const handleDelete = () => {
    const result = mode === "buy" && event ? removeBoughtHome(event.id) : account ? removeExistingHome(account.id) : null;
    if (!result) return;
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <Drawer open={open} onClose={onClose} title={isEditing ? "Edit Home" : "Add a Home"}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />

        {!isEditing && (
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === "existing" ? "bg-accent text-white" : "text-dim hover:text-foreground"}`}
            >
              Already own it
            </button>
            <button
              type="button"
              onClick={() => setMode("buy")}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === "buy" ? "bg-accent text-white" : "text-dim hover:text-foreground"}`}
            >
              Buying it
            </button>
          </div>
        )}

        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Home" />
        </Field>

        {mode === "buy" && (
          <Field label="Purchase (Closing) Date">
            <TextInput reg={register("startDate", { required: true })} type="date" />
          </Field>
        )}

        <Field label={mode === "existing" ? "Current Estimated Value" : "Purchase Price"} hint={mode === "buy" ? "Today's dollars -- inflated forward to the closing date." : undefined}>
          <TextInput reg={register("value", { required: true })} type="number" step="0.01" />
        </Field>

        {mode === "buy" && (
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setValue("financed", true)}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${financed ? "bg-accent text-white" : "text-dim hover:text-foreground"}`}
            >
              Finance
            </button>
            <button
              type="button"
              onClick={() => setValue("financed", false)}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${!financed ? "bg-accent text-white" : "text-dim hover:text-foreground"}`}
            >
              Pay cash
            </button>
          </div>
        )}

        {mode === "buy" && financed && (
          <Field label="Down Payment" hint="Today's dollars -- inflated the same as the purchase price, so it stays the same share.">
            <TextInput reg={register("downPaymentAmount", { required: true })} type="number" step="0.01" />
          </Field>
        )}

        {mode === "existing" && (
          <CheckboxInput reg={register("hasMortgage")} label="Still have a mortgage on it" />
        )}

        {mode === "existing" && hasMortgage && (
          <Field label="Remaining Balance">
            <TextInput reg={register("mortgageBalance", { required: true })} type="number" step="0.01" />
          </Field>
        )}

        {isFinanced && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Interest Rate (e.g. 0.065 for 6.5%)">
              <TextInput reg={register("mortgageRate")} type="number" step="0.001" />
            </Field>
            <Field label={mode === "existing" ? "Years Remaining" : "Term (years)"}>
              <TextInput reg={register("mortgageTermYears")} type="number" step="1" min="1" />
            </Field>
          </div>
        )}
        {isFinanced && (
          <Field label="Extra Principal / month (optional)" hint="Paid on top of the scheduled payment -- pays the loan off early.">
            <TextInput reg={register("mortgageExtraPrincipal")} type="number" step="0.01" placeholder="e.g. 200" />
          </Field>
        )}

        {mode === "buy" && (
          <Field label="Pay Down Payment From">
            <SelectInput reg={register("downPaymentFromAccountId", { required: true })} options={accountOptions} />
          </Field>
        )}

        <Field label="Annual Appreciation Rate (e.g. 0.03 for 3%)">
          <TextInput reg={register("growthRatePct")} type="number" step="0.001" />
        </Field>
        <Field label="Property Tax Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.01 = 1%. Grows with the home.">
          <TextInput reg={register("propertyTaxRatePct")} type="number" step="0.001" placeholder="e.g. 0.01" />
        </Field>
        <Field label="Home Insurance Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.005 = 0.5%. Grows with the home.">
          <TextInput reg={register("homeInsuranceRatePct")} type="number" step="0.001" placeholder="e.g. 0.005" />
        </Field>
        <Field label="Maintenance Rate (per year, optional)" hint="Share of the home's value per year -- the classic '1% rule' upkeep estimate. Grows with the home.">
          <TextInput reg={register("maintenanceRatePct")} type="number" step="0.001" placeholder="e.g. 0.01" />
        </Field>

        {mode === "buy" && (
          <>
            <CheckboxInput reg={register("replaceHousingExpenses")} label="Replace existing housing expenses" />
            {watch("replaceHousingExpenses") && (
              <p className="-mt-2 pl-6 text-xs text-dim">
                Any expense categorized as "Housing" (e.g. rent) stops the day before this purchase closes.
              </p>
            )}
          </>
        )}

        {value > 0 && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-dim">Est. monthly cost</span>
              <span className="text-base font-semibold">{money0(monthlyTotal)}</span>
            </div>
            <div className="flex flex-col gap-1 text-xs text-dim">
              {isFinanced && (
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

        <div className="mt-2 flex items-center justify-between gap-2">
          {isEditing ? (
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md border border-negative/40 px-3 py-1.5 text-sm text-negative hover:bg-negative/10"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
              Cancel
            </button>
            <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white">
              {isEditing ? "Save" : "Add Home"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
