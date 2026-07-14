"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { nanoid } from "nanoid";
import type { Account, AccountClass, Person, RecurrenceFrequency, TaxTreatment } from "@/domain";
import { accountObjectSchema, categoryForClass } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner, inputClass, labelClass } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

const CLASS_OPTIONS: { value: AccountClass; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "taxable_investment", label: "Taxable Investment" },
  { value: "tax_deferred", label: "Tax-deferred (Traditional 401k/IRA)" },
  { value: "tax_free", label: "Tax-free (Roth 401k/IRA)" },
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
  contributionStartDate: string;
  contributionAmount: string;
  contributionFrequency: RecurrenceFrequency;
  contributionGrowthRatePct: string;
  contributionFunding: string;
  contributionEndDate: string;
}

/** An additional (beyond the base) growth-rate change, edited as its own row. */
interface GrowthRow {
  key: string;
  startDate: string;
  ratePct: string;
}

/** An additional (beyond the base) contribution segment, edited as its own row. */
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
  // A contributionSchedule (when present) supersedes `contribution` -- its
  // first segment fills the same base fields a simple single-value
  // contribution would, so editing an account with only one segment looks
  // identical to editing one with a plain `contribution`.
  const baseContribution = account?.contributionSchedule?.[0] ?? account?.contribution ?? undefined;
  return {
    name: account?.name ?? "",
    class: account?.class ?? "cash",
    ownerId: account?.ownerId ?? "",
    startingBalance: account?.startingBalance ?? 0,
    growthRatePct: account?.growthRatePct ?? 0,
    taxTreatment: account?.taxTreatment ?? "n/a",
    subjectToRMD: account?.subjectToRMD ?? false,
    isExcluded: account?.isExcluded ?? false,
    contributionStartDate: account?.contributionSchedule?.[0]?.startDate ?? "",
    contributionAmount: baseContribution?.amount?.toString() ?? "",
    contributionFrequency: baseContribution?.frequency ?? "monthly",
    contributionGrowthRatePct: baseContribution?.growthRatePct?.toString() ?? "0",
    contributionEndDate: baseContribution?.endDate ?? "",
    // Seed the funding source from the stored value, else suggest one from the
    // account type (tax-deferred accounts are almost always payroll-deducted).
    contributionFunding:
      baseContribution?.payrollDeducted !== undefined
        ? baseContribution.payrollDeducted
          ? "paycheck"
          : "take_home"
        : account?.taxTreatment === "tax_deferred"
          ? "paycheck"
          : "take_home",
  };
}

function toGrowthRows(account?: Account): GrowthRow[] {
  return (account?.growthRateSchedule ?? []).map((e) => ({ key: nanoid(), startDate: e.startDate, ratePct: e.ratePct.toString() }));
}

/** Additional rows are every contributionSchedule segment AFTER the first, which fills the base fields instead (see toFormValues). */
function toContribRows(account?: Account): ContribRow[] {
  return (account?.contributionSchedule ?? []).slice(1).map((seg) => ({
    key: nanoid(),
    startDate: seg.startDate,
    amount: seg.amount.toString(),
    frequency: seg.frequency,
    growthRatePct: seg.growthRatePct.toString(),
    funding: seg.payrollDeducted ? "paycheck" : "take_home",
    endDate: seg.endDate ?? "",
  }));
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

  const { register, handleSubmit, reset, watch } = useForm<FormValues>({
    defaultValues: toFormValues(account),
  });

  useEffect(() => {
    reset(toFormValues(account));
    setGrowthRows(toGrowthRows(account));
    setContribRows(toContribRows(account));
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
  const contributionAmount = watch("contributionAmount");
  const contributionFunding = watch("contributionFunding");
  const showRmdCheckbox = isEffectivelyTaxDeferred(selectedClass, selectedTaxTreatment);

  const addGrowthRow = () => setGrowthRows((rows) => [...rows, { key: nanoid(), startDate: "", ratePct: "" }]);
  const updateGrowthRow = (key: string, patch: Partial<GrowthRow>) =>
    setGrowthRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeGrowthRow = (key: string) => setGrowthRows((rows) => rows.filter((r) => r.key !== key));

  const addContribRow = () =>
    setContribRows((rows) => [
      ...rows,
      { key: nanoid(), startDate: "", amount: "", frequency: "monthly", growthRatePct: "0", funding: "take_home", endDate: "" },
    ]);
  const updateContribRow = (key: string, patch: Partial<ContribRow>) =>
    setContribRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeContribRow = (key: string) => setContribRows((rows) => rows.filter((r) => r.key !== key));

  const onSubmit = (values: FormValues) => {
    const cls = values.class;

    const growthRateSchedule = growthRows
      .filter((r) => r.startDate && r.ratePct.trim() !== "")
      .map((r) => ({ startDate: r.startDate, ratePct: Number(r.ratePct) }));

    const baseAmount = Number(values.contributionAmount);
    const hasBaseContribution = values.contributionAmount.trim() !== "" && baseAmount > 0;
    const validContribRows = contribRows.filter((r) => r.startDate && r.amount.trim() !== "" && Number(r.amount) > 0);

    // A schedule (2+ segments) supersedes the single `contribution` field; a
    // plain single-value contribution (the common case) keeps using
    // `contribution` untouched, so simple accounts don't churn their saved shape.
    let contribution = null as Account["contribution"];
    let contributionSchedule: Account["contributionSchedule"];
    if (validContribRows.length > 0) {
      const segments: NonNullable<Account["contributionSchedule"]> = [];
      if (hasBaseContribution) {
        segments.push({
          startDate: values.contributionStartDate.trim() || planStartDate,
          amount: baseAmount,
          frequency: values.contributionFrequency,
          growthRatePct: Number(values.contributionGrowthRatePct) || 0,
          payrollDeducted: values.contributionFunding === "paycheck",
          endDate: values.contributionEndDate.trim() === "" ? null : values.contributionEndDate,
        });
      }
      for (const r of validContribRows) {
        segments.push({
          startDate: r.startDate,
          amount: Number(r.amount),
          frequency: r.frequency,
          growthRatePct: Number(r.growthRatePct) || 0,
          payrollDeducted: r.funding === "paycheck",
          endDate: r.endDate.trim() === "" ? null : r.endDate,
        });
      }
      contributionSchedule = segments;
    } else if (hasBaseContribution) {
      contribution = {
        amount: baseAmount,
        frequency: values.contributionFrequency,
        growthRatePct: Number(values.contributionGrowthRatePct) || 0,
        payrollDeducted: values.contributionFunding === "paycheck",
        endDate: values.contributionEndDate.trim() === "" ? null : values.contributionEndDate,
      };
    }

    const candidate = {
      name: values.name.trim(),
      class: cls,
      category: categoryForClass(cls),
      ownerId: values.ownerId || null,
      startingBalance: Number(values.startingBalance),
      growthRatePct: Number(values.growthRatePct),
      isExcluded: values.isExcluded,
      taxTreatment: values.taxTreatment,
      // A Roth account (class or explicit taxTreatment) can never be subject
      // to RMDs -- clear a stale checked box left over from before the
      // account was marked/reclassed as tax-free.
      subjectToRMD: values.subjectToRMD && isEffectivelyTaxDeferred(cls, values.taxTreatment),
      contribution,
      growthRateSchedule: growthRateSchedule.length > 0 ? growthRateSchedule : undefined,
      contributionSchedule,
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
        <Field label="Annual Growth Rate (e.g. 0.07 for 7%)">
          <TextInput reg={register("growthRatePct", { valueAsNumber: true })} type="number" step="0.001" />
        </Field>
        {growthRows.length > 0 && (
          <p className="text-xs text-dim">Rate above applies until the first scheduled change below.</p>
        )}
        {growthRows.map((row) => (
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
        <button
          type="button"
          onClick={addGrowthRow}
          className="self-start rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
        >
          + Add growth-rate change
        </button>
        <Field label="Owner">
          <SelectInput
            reg={register("ownerId")}
            options={[{ value: "", label: "Joint / none" }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>

        <p className="text-xs text-dim">
          Whether this account is a spending hub, receives routed surplus, or gets drawn down for a shortfall is set
          in the <span className="font-medium text-foreground">Routing</span> tab, not here.
        </p>

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
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">Recurring Contribution</div>
              {contribRows.length > 0 && (
                <Field label="Starts on">
                  <TextInput reg={register("contributionStartDate")} type="date" />
                </Field>
              )}
              <Field label="Contribution Amount (per occurrence, blank = none)">
                <TextInput reg={register("contributionAmount")} type="number" step="0.01" placeholder="e.g. 1500" />
              </Field>
              {contributionAmount?.trim() !== "" && (
                <>
                  <Field label="Contribution Frequency">
                    <SelectInput reg={register("contributionFrequency")} options={FREQUENCY_OPTIONS} />
                  </Field>
                  <Field label="Contribution Growth Rate (optional, actual)">
                    <TextInput reg={register("contributionGrowthRatePct")} type="number" step="0.001" />
                  </Field>
                  <Field label="Funded from">
                    <SelectInput reg={register("contributionFunding")} options={FUNDING_OPTIONS} />
                  </Field>
                  <p className="mt-1 text-xs text-dim">
                    {contributionFunding === "paycheck"
                      ? "Deducted from your paycheck before take-home (e.g. a 401k or Roth 401k), so it grows this account without reducing your cash flow. Enter your income net of it."
                      : "Drawn from your spending account each period, on top of your expenses (e.g. a Roth IRA or taxable brokerage)."}
                  </p>
                  <Field label={contribRows.length > 0 ? "Ends on (optional; blank = until the next row starts)" : "Stop contributing on (optional)"}>
                    <TextInput reg={register("contributionEndDate")} type="date" />
                  </Field>
                  <p className="mt-1 text-xs text-dim">
                    Leave blank to stop automatically when the account&rsquo;s owner retires (a paycheck deduction
                    can&rsquo;t outlive the paycheck). Set a date to stop sooner, or to cap a joint account with no
                    single retiree.
                  </p>
                </>
              )}

              {contribRows.map((row) => (
                <div key={row.key} className="mt-3 flex flex-col gap-2 rounded-md border border-border p-2">
                  <div className="flex items-end gap-2">
                    <label className={labelClass}>
                      Starts on
                      <input
                        className={inputClass}
                        type="date"
                        value={row.startDate}
                        onChange={(e) => updateContribRow(row.key, { startDate: e.target.value })}
                      />
                    </label>
                    <label className={labelClass}>
                      Amount
                      <input
                        className={inputClass}
                        type="number"
                        step="0.01"
                        placeholder="e.g. 2000"
                        value={row.amount}
                        onChange={(e) => updateContribRow(row.key, { amount: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeContribRow(row.key)}
                      className="pb-1.5 text-xs text-negative hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
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
                    <label className={labelClass}>
                      Funded from
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
                      Ends on (optional)
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
                className="mt-2 rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
              >
                + Add contribution change
              </button>
            </div>

            <CheckboxInput
              reg={register("isExcluded")}
              label="Excluded (kept visible for reference, no effect on the projection)"
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          {account ? (
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
