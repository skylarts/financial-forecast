"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { nanoid } from "nanoid";
import type { Account, AccountClass, Person, RecurrenceFrequency, TaxTreatment } from "@/domain";
import { accountObjectSchema, categoryForClass } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner, InfoTooltip, inputClass, labelClass } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

const CLASS_OPTIONS: { value: AccountClass; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "taxable_investment", label: "Taxable Investment" },
  { value: "tax_deferred", label: "Tax-deferred (Traditional 401k/IRA)" },
  { value: "tax_free", label: "Tax-free (Roth 401k/IRA)" },
  { value: "real_estate", label: "Real Estate (Home)" },
  { value: "other_asset", label: "Other Asset" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan" },
];

/** Mirrors engine's effectiveTaxTreatment: explicit taxTreatment wins, else infer from class. */
function isEffectivelyTaxDeferred(cls: AccountClass, taxTreatment: TaxTreatment): boolean {
  if (taxTreatment !== "n/a") return taxTreatment === "tax_deferred";
  return cls === "tax_deferred";
}

const TAX_TREATMENT_OPTIONS: { value: TaxTreatment; label: string }[] = [
  { value: "n/a", label: "N/A" },
  { value: "taxable", label: "Taxable" },
  { value: "tax_deferred", label: "Tax-deferred" },
  { value: "tax_free", label: "Tax-free" },
];

const FREQUENCY_OPTIONS: { value: RecurrenceFrequency; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "weekly", label: "Weekly" },
  { value: "annual", label: "Annual" },
  { value: "one_time", label: "One time" },
];

const FUNDING_OPTIONS: { value: string; label: string }[] = [
  { value: "take_home", label: "Take-home pay (a cash outflow)" },
  { value: "paycheck", label: "Paycheck deduction (excluded from take-home)" },
];

interface FormValues {
  name: string;
  class: AccountClass;
  ownerId: string;
  startingBalance: number;
  growthRatePct: number;
  taxTreatment: TaxTreatment;
  subjectToRMD: boolean;
  isExcluded: boolean;
}

/** Loan terms for class "loan" -- amortized monthly by the engine (see
 *  resolveEvents.ts, which registers any loan/mortgage-class account with
 *  loanTerms for amortization, not just ones created via a buy_home event).
 *  `originalPrincipal` isn't user-edited here -- it's set to the account's
 *  current Starting Balance at save time, same convention the buy_home event
 *  and the setup wizard's "home you already own" flow use. */
interface LoanDraft {
  annualInterestRatePct: string;
  termYears: string;
  monthlyPayment: string;
}

function toLoanDraft(account?: Account): LoanDraft {
  const lt = account?.loanTerms;
  return {
    annualInterestRatePct: lt ? lt.annualInterestRatePct.toString() : "0.07",
    termYears: lt ? Math.round(lt.termMonths / 12).toString() : "5",
    monthlyPayment: lt?.monthlyPayment?.toString() ?? "",
  };
}

/** Home-specific fields for class "real_estate" -- kept as free-text strings
 *  (like LoanDraft) since they're all optional and a blank field must stay
 *  blank (omitted from the saved account), not coerce to 0. */
interface HomeDraft {
  propertyGrowthRatePct: string;
  propertyTaxRatePct: string;
  homeInsuranceRatePct: string;
  maintenanceRatePct: string;
}

function toHomeDraft(account?: Account): HomeDraft {
  return {
    propertyGrowthRatePct: account?.propertyGrowthRatePct?.toString() ?? "",
    propertyTaxRatePct: account?.propertyTaxRatePct?.toString() ?? "",
    homeInsuranceRatePct: account?.homeInsuranceRatePct?.toString() ?? "",
    maintenanceRatePct: account?.maintenanceRatePct?.toString() ?? "",
  };
}

/** A scheduled growth-rate change, edited as its own row (beyond the base rate above). */
interface GrowthRow {
  key: string;
  startDate: string;
  ratePct: string;
}

/**
 * One contribution segment. Every contribution -- including the first/only one
 * -- is edited as one of these uniform rows, so "+ Add" just stamps out another
 * identical block for a different date range. A single row with a blank start
 * date is saved back as the simple `contribution` field (no schedule churn);
 * anything more becomes a `contributionSchedule`.
 */
interface ContribRow {
  key: string;
  startDate: string;
  amount: string;
  frequency: RecurrenceFrequency;
  growthRatePct: string;
  funding: string;
  endDate: string;
}

function toFormValues(account?: Account): FormValues {
  return {
    name: account?.name ?? "",
    class: account?.class ?? "cash",
    ownerId: account?.ownerId ?? "",
    startingBalance: account?.startingBalance ?? 0,
    growthRatePct: account?.growthRatePct ?? 0,
    taxTreatment: account?.taxTreatment ?? "n/a",
    subjectToRMD: account?.subjectToRMD ?? false,
    isExcluded: account?.isExcluded ?? false,
  };
}

function toGrowthRows(account?: Account): GrowthRow[] {
  return (account?.growthRateSchedule ?? []).map((e) => ({ key: nanoid(), startDate: e.startDate, ratePct: e.ratePct.toString() }));
}

/**
 * Loads contributions into uniform rows. A multi-segment schedule maps
 * one-to-one; a plain single `contribution` becomes a single row with a blank
 * start date (meaning "from the plan start"), so it round-trips back to the
 * simple `contribution` field on save. No contribution -> no rows.
 */
function toContribRows(account?: Account): ContribRow[] {
  if (account?.contributionSchedule?.length) {
    return account.contributionSchedule.map((seg) => ({
      key: nanoid(),
      startDate: seg.startDate,
      amount: seg.amount.toString(),
      frequency: seg.frequency,
      growthRatePct: (seg.growthRatePct ?? 0).toString(),
      funding: seg.payrollDeducted ? "paycheck" : "take_home",
      endDate: seg.endDate ?? "",
    }));
  }
  if (account?.contribution) {
    const c = account.contribution;
    return [
      {
        key: nanoid(),
        startDate: "",
        amount: c.amount.toString(),
        frequency: c.frequency,
        growthRatePct: (c.growthRatePct ?? 0).toString(),
        funding: c.payrollDeducted ? "paycheck" : "take_home",
        endDate: c.endDate ?? "",
      },
    ];
  }
  return [];
}

export function AccountDrawer({
  open,
  onClose,
  account,
  people,
}: {
  open: boolean;
  onClose: () => void;
  account?: Account;
  people: Person[];
}) {
  const addAccount = usePlanStore((s) => s.addAccount);
  const updateAccount = usePlanStore((s) => s.updateAccount);
  const removeAccount = usePlanStore((s) => s.removeAccount);
  const planStartDate = usePlanStore((s) => s.activeScenario().settings.startDate);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [growthRows, setGrowthRows] = useState<GrowthRow[]>(() => toGrowthRows(account));
  const [contribRows, setContribRows] = useState<ContribRow[]>(() => toContribRows(account));
  const [loanDraft, setLoanDraft] = useState<LoanDraft>(() => toLoanDraft(account));
  const [homeDraft, setHomeDraft] = useState<HomeDraft>(() => toHomeDraft(account));

  const { register, handleSubmit, reset, watch } = useForm<FormValues>({
    defaultValues: toFormValues(account),
  });

  useEffect(() => {
    reset(toFormValues(account));
    setGrowthRows(toGrowthRows(account));
    setContribRows(toContribRows(account));
    setLoanDraft(toLoanDraft(account));
    setHomeDraft(toHomeDraft(account));
    setError(null);
    // Auto-expand Advanced when editing an account that already has
    // something set there, so it's never silently hidden.
    setAdvancedOpen(
      !!account &&
        (account.subjectToRMD ||
          account.isExcluded === true ||
          account.taxTreatment !== "n/a" ||
          !!account.contribution ||
          !!account.contributionSchedule?.length)
    );
  }, [account, open, reset]);

  const selectedClass = watch("class");
  const selectedTaxTreatment = watch("taxTreatment");
  const showRmdCheckbox = isEffectivelyTaxDeferred(selectedClass, selectedTaxTreatment);

  const addGrowthRow = () => setGrowthRows((rows) => [...rows, { key: nanoid(), startDate: "", ratePct: "" }]);
  const updateGrowthRow = (key: string, patch: Partial<GrowthRow>) =>
    setGrowthRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeGrowthRow = (key: string) => setGrowthRows((rows) => rows.filter((r) => r.key !== key));

  const addContribRow = () =>
    setContribRows((rows) => {
      const last = rows[rows.length - 1];
      // Suggest a funding source: inherit the previous row's, else infer from
      // the account type (tax-deferred accounts are usually payroll-deducted).
      const funding = last?.funding ?? (selectedTaxTreatment === "tax_deferred" ? "paycheck" : "take_home");
      return [
        ...rows,
        { key: nanoid(), startDate: "", amount: "", frequency: last?.frequency ?? "monthly", growthRatePct: "0", funding, endDate: "" },
      ];
    });
  const updateContribRow = (key: string, patch: Partial<ContribRow>) =>
    setContribRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeContribRow = (key: string) => setContribRows((rows) => rows.filter((r) => r.key !== key));

  const onSubmit = (values: FormValues) => {
    const cls = values.class;

    const growthRateSchedule = growthRows
      .filter((r) => r.startDate && r.ratePct.trim() !== "")
      .map((r) => ({ startDate: r.startDate, ratePct: Number(r.ratePct) }));

    // Every contribution segment with a positive amount counts. A single
    // segment with a blank start date collapses back to the simple
    // `contribution` field (no schedule churn for the common case); anything
    // else becomes a `contributionSchedule`.
    const validContribRows = contribRows.filter((r) => r.amount.trim() !== "" && Number(r.amount) > 0);
    let contribution = null as Account["contribution"];
    let contributionSchedule: Account["contributionSchedule"];

    if (validContribRows.length === 1 && validContribRows[0].startDate.trim() === "") {
      const r = validContribRows[0];
      contribution = {
        amount: Number(r.amount),
        frequency: r.frequency,
        growthRatePct: Number(r.growthRatePct) || 0,
        payrollDeducted: r.funding === "paycheck",
        endDate: r.endDate.trim() === "" ? null : r.endDate,
      };
    } else if (validContribRows.length >= 1) {
      // Only one segment may omit a start date (it begins at the plan start);
      // the rest need one, or the engine can't tell which window they cover.
      const blanks = validContribRows.filter((r) => r.startDate.trim() === "").length;
      if (blanks > 1) {
        setError(
          "Only one contribution date range can be left without a start date (it begins at the plan start). Give the others a start date."
        );
        return;
      }
      contributionSchedule = validContribRows.map((r) => ({
        startDate: r.startDate.trim() || planStartDate,
        amount: Number(r.amount),
        frequency: r.frequency,
        growthRatePct: Number(r.growthRatePct) || 0,
        payrollDeducted: r.funding === "paycheck",
        endDate: r.endDate.trim() === "" ? null : r.endDate,
      }));
    }

    // Amortized classes don't grow via growthRatePct at all (see
    // forecastScenario.ts's monthly growth step, which skips credit_card/
    // loan/mortgage entirely) -- force it to 0 rather than leave a stale,
    // misleading rate on the record.
    const isLoan = cls === "loan";
    const termMonths = Math.max(1, Math.round(Number(loanDraft.termYears) || 0) * 12);
    const loanTerms: Account["loanTerms"] = isLoan
      ? {
          originalPrincipal: Number(values.startingBalance) || 0,
          originationDate: planStartDate,
          annualInterestRatePct: Number(loanDraft.annualInterestRatePct) || 0,
          termMonths,
          monthlyPayment: loanDraft.monthlyPayment.trim() !== "" ? Number(loanDraft.monthlyPayment) : undefined,
        }
      : undefined;

    const isRealEstate = cls === "real_estate";
    const candidate = {
      name: values.name.trim(),
      class: cls,
      category: categoryForClass(cls),
      ownerId: values.ownerId || null,
      startingBalance: Number(values.startingBalance),
      growthRatePct: cls === "loan" || cls === "credit_card" ? 0 : Number(values.growthRatePct),
      isExcluded: values.isExcluded,
      taxTreatment: values.taxTreatment,
      // A Roth account (class or explicit taxTreatment) can never be subject
      // to RMDs -- clear a stale checked box left over from before the
      // account was marked/reclassed as tax-free.
      subjectToRMD: values.subjectToRMD && isEffectivelyTaxDeferred(cls, values.taxTreatment),
      contribution,
      growthRateSchedule: growthRateSchedule.length > 0 ? growthRateSchedule : undefined,
      contributionSchedule,
      loanTerms,
      // Real-estate-only fields, edited via homeDraft above (not react-hook-form,
      // same free-text-string pattern as loanDraft). Preserve linkedLiabilityId
      // (e.g. the mortgage set up by "Add a Home You Already Own" or a buy_home
      // event) since there's no UI control for it here -- it would otherwise be
      // silently dropped on every save of an existing real_estate account.
      propertyGrowthRatePct: isRealEstate && homeDraft.propertyGrowthRatePct.trim() !== "" ? Number(homeDraft.propertyGrowthRatePct) : undefined,
      propertyTaxRatePct: isRealEstate && homeDraft.propertyTaxRatePct.trim() !== "" ? Number(homeDraft.propertyTaxRatePct) : undefined,
      homeInsuranceRatePct: isRealEstate && homeDraft.homeInsuranceRatePct.trim() !== "" ? Number(homeDraft.homeInsuranceRatePct) : undefined,
      maintenanceRatePct: isRealEstate && homeDraft.maintenanceRatePct.trim() !== "" ? Number(homeDraft.maintenanceRatePct) : undefined,
      linkedLiabilityId: isRealEstate ? account?.linkedLiabilityId : undefined,
    };

    const result = accountObjectSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid account.");
      return;
    }

    if (account) updateAccount(account.id, result.data);
    else addAccount(result.data);
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title={account ? "Edit Account" : "Add Account"}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Joint Checking" />
        </Field>
        <Field label="Class">
          <SelectInput reg={register("class")} options={CLASS_OPTIONS} />
        </Field>
        <Field label="Starting Balance">
          <TextInput reg={register("startingBalance", { valueAsNumber: true })} type="number" step="0.01" />
        </Field>
        {selectedClass === "loan" && (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
              Loan Details
              <InfoTooltip text="The balance above is amortized monthly at this rate and term -- a payment is drawn from your spending account automatically, same as a mortgage." />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className={labelClass}>
                Interest rate (e.g. 0.07 for 7%)
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  value={loanDraft.annualInterestRatePct}
                  onChange={(e) => setLoanDraft((d) => ({ ...d, annualInterestRatePct: e.target.value }))}
                />
              </label>
              <label className={labelClass}>
                Years remaining
                <input
                  className={inputClass}
                  type="number"
                  step="1"
                  min="1"
                  value={loanDraft.termYears}
                  onChange={(e) => setLoanDraft((d) => ({ ...d, termYears: e.target.value }))}
                />
              </label>
              <label className={labelClass}>
                <span className="inline-flex items-center gap-1">
                  Monthly payment (optional)
                  <InfoTooltip text="Leave blank to calculate automatically from the balance, rate, and remaining term." />
                </span>
                <input
                  className={inputClass}
                  type="number"
                  step="0.01"
                  placeholder="auto"
                  value={loanDraft.monthlyPayment}
                  onChange={(e) => setLoanDraft((d) => ({ ...d, monthlyPayment: e.target.value }))}
                />
              </label>
            </div>
          </div>
        )}
        {selectedClass === "real_estate" && (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
              Home Details
              <InfoTooltip text="Property tax, insurance, and maintenance are each a share of the home's (growing) value per year, paid monthly from your spending account. Leave any blank to skip it." />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className={labelClass}>
                Appreciation rate (e.g. 0.03 for 3%)
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  placeholder="e.g. 0.03"
                  value={homeDraft.propertyGrowthRatePct}
                  onChange={(e) => setHomeDraft((d) => ({ ...d, propertyGrowthRatePct: e.target.value }))}
                />
              </label>
              <label className={labelClass}>
                Property tax rate
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  placeholder="e.g. 0.01"
                  value={homeDraft.propertyTaxRatePct}
                  onChange={(e) => setHomeDraft((d) => ({ ...d, propertyTaxRatePct: e.target.value }))}
                />
              </label>
              <label className={labelClass}>
                Home insurance rate
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  placeholder="e.g. 0.005"
                  value={homeDraft.homeInsuranceRatePct}
                  onChange={(e) => setHomeDraft((d) => ({ ...d, homeInsuranceRatePct: e.target.value }))}
                />
              </label>
              <label className={labelClass}>
                Maintenance rate
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  placeholder="e.g. 0.01"
                  value={homeDraft.maintenanceRatePct}
                  onChange={(e) => setHomeDraft((d) => ({ ...d, maintenanceRatePct: e.target.value }))}
                />
              </label>
            </div>
          </div>
        )}
        {selectedClass !== "loan" && selectedClass !== "credit_card" && selectedClass !== "real_estate" && (
          <Field
            label="Annual Growth Rate (e.g. 0.07 for 7%)"
            hint={
              "Use a nominal rate (i.e. the rate you'd actually see reported, already including inflation) — not an inflation-adjusted \"real\" rate. For example, use 0.07 for a 7% stock market return, not 0.045 for its inflation-adjusted equivalent." +
              (growthRows.length > 0 ? " Applies until the first scheduled change below." : "")
            }
          >
            <TextInput reg={register("growthRatePct", { valueAsNumber: true })} type="number" step="0.001" />
          </Field>
        )}
        {selectedClass !== "loan" && selectedClass !== "credit_card" && growthRows.map((row) => (
          <div key={row.key} className="flex items-end gap-2 rounded-md border border-border p-2">
            <label className={labelClass}>
              Starting
              <input
                className={inputClass}
                type="date"
                value={row.startDate}
                onChange={(e) => updateGrowthRow(row.key, { startDate: e.target.value })}
              />
            </label>
            <label className={labelClass}>
              New rate
              <input
                className={inputClass}
                type="number"
                step="0.001"
                placeholder="e.g. 0.05"
                value={row.ratePct}
                onChange={(e) => updateGrowthRow(row.key, { ratePct: e.target.value })}
              />
            </label>
            <button type="button" onClick={() => removeGrowthRow(row.key)} className="pb-1.5 text-xs text-negative hover:underline">
              Remove
            </button>
          </div>
        ))}
        {selectedClass !== "loan" && selectedClass !== "credit_card" && (
          <button
            type="button"
            onClick={addGrowthRow}
            className="self-start rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
          >
            + Add growth-rate change
          </button>
        )}
        <Field label="Owner">
          <SelectInput
            reg={register("ownerId")}
            options={[{ value: "", label: "Joint / none" }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>

        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-dim hover:text-foreground"
        >
          <span className="inline-block w-3">{advancedOpen ? "▾" : "▸"}</span>
          Advanced
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-3 border-l border-border pl-3">
            <Field label="Tax Treatment (blank/N-A infers from class)">
              <SelectInput reg={register("taxTreatment")} options={TAX_TREATMENT_OPTIONS} />
            </Field>
            {showRmdCheckbox && (
              <CheckboxInput reg={register("subjectToRMD")} label="Subject to RMDs (age 73+)" />
            )}

            <div className="rounded-md border border-border p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">Recurring Contributions</div>
              {contribRows.length === 0 && (
                <p className="text-xs text-dim">
                  None yet. Add one to grow this account each period; add more to change the amount over time.
                </p>
              )}

              {contribRows.map((row, i) => (
                <div key={row.key} className="mb-2 flex flex-col gap-2 rounded-md border border-border p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-dim">
                      {i === 0 ? "Contribution" : "Contribution change"}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeContribRow(row.key)}
                      className="text-xs text-negative hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className={labelClass}>
                      Starts on{i === 0 ? " (blank = plan start)" : ""}
                      <input
                        className={inputClass}
                        type="date"
                        value={row.startDate}
                        onChange={(e) => updateContribRow(row.key, { startDate: e.target.value })}
                      />
                    </label>
                    <label className={labelClass}>
                      Amount (per occurrence)
                      <input
                        className={inputClass}
                        type="number"
                        step="0.01"
                        placeholder="e.g. 1500"
                        value={row.amount}
                        onChange={(e) => updateContribRow(row.key, { amount: e.target.value })}
                      />
                    </label>
                    <label className={labelClass}>
                      Frequency
                      <select
                        className={inputClass}
                        value={row.frequency}
                        onChange={(e) => updateContribRow(row.key, { frequency: e.target.value as RecurrenceFrequency })}
                      >
                        {FREQUENCY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className={labelClass}>
                      Growth rate (optional, actual)
                      <input
                        className={inputClass}
                        type="number"
                        step="0.001"
                        placeholder="0"
                        value={row.growthRatePct}
                        onChange={(e) => updateContribRow(row.key, { growthRatePct: e.target.value })}
                      />
                    </label>
                    <label className={labelClass}>
                      <span className="inline-flex items-center gap-1">
                        Funded from
                        <InfoTooltip text="Paycheck deduction (e.g. 401k) grows this account without reducing take-home cash -- enter income net of it. Take-home pay (e.g. Roth IRA, brokerage) is drawn from your spending account each period." />
                      </span>
                      <select
                        className={inputClass}
                        value={row.funding}
                        onChange={(e) => updateContribRow(row.key, { funding: e.target.value })}
                      >
                        {FUNDING_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={labelClass}>
                      <span className="inline-flex items-center gap-1">
                        Ends on (optional)
                        <InfoTooltip text="Leave blank to stop automatically when this account's owner retires. Each change takes over when the next one starts." />
                      </span>
                      <input
                        className={inputClass}
                        type="date"
                        value={row.endDate}
                        onChange={(e) => updateContribRow(row.key, { endDate: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addContribRow}
                className="mt-1 rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
              >
                {contribRows.length === 0 ? "+ Add contribution" : "+ Add contribution change"}
              </button>
            </div>

            <CheckboxInput
              reg={register("isExcluded")}
              label="Excluded (kept visible for reference, no effect on the projection)"
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          {account && account.isExtraSavings ? (
            <span className="text-xs text-dim">Extra Savings is a system account and can&rsquo;t be deleted.</span>
          ) : account ? (
            <button
              type="button"
              onClick={() => {
                const removed = removeAccount(account.id);
                if (removed) onClose();
                else
                  alert(
                    `Can't delete ${account.name || "this account"} -- it's still used as a payment, deposit, or transfer account by an expense, income source, or event. Update or delete those first.`
                  );
              }}
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
              {account ? "Save" : "Add Account"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
