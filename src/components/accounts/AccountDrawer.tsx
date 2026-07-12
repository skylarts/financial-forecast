"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, AccountClass, Person, RecurrenceFrequency, TaxTreatment } from "@/domain";
import { accountObjectSchema, categoryForClass } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
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
  contributionAmount: string;
  contributionFrequency: RecurrenceFrequency;
  contributionGrowthRatePct: string;
  contributionFunding: string;
  contributionEndDate: string;
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
    contributionAmount: account?.contribution?.amount?.toString() ?? "",
    contributionFrequency: account?.contribution?.frequency ?? "monthly",
    contributionGrowthRatePct: account?.contribution?.growthRatePct?.toString() ?? "0",
    contributionEndDate: account?.contribution?.endDate ?? "",
    // Seed the funding source from the stored value, else suggest one from the
    // account type (tax-deferred accounts are almost always payroll-deducted).
    contributionFunding:
      account?.contribution?.payrollDeducted !== undefined
        ? account.contribution.payrollDeducted
          ? "paycheck"
          : "take_home"
        : account?.taxTreatment === "tax_deferred"
          ? "paycheck"
          : "take_home",
  };
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
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { register, handleSubmit, reset, watch } = useForm<FormValues>({
    defaultValues: toFormValues(account),
  });

  useEffect(() => {
    reset(toFormValues(account));
    setError(null);
    // Auto-expand Advanced when editing an account that already has
    // something set there, so it's never silently hidden.
    setAdvancedOpen(
      !!account &&
        (account.subjectToRMD ||
          account.isExcluded === true ||
          account.taxTreatment !== "n/a" ||
          !!account.contribution)
    );
  }, [account, open, reset]);

  const selectedClass = watch("class");
  const selectedTaxTreatment = watch("taxTreatment");
  const contributionAmount = watch("contributionAmount");
  const contributionFunding = watch("contributionFunding");
  const showRmdCheckbox = isEffectivelyTaxDeferred(selectedClass, selectedTaxTreatment);

  const onSubmit = (values: FormValues) => {
    const cls = values.class;
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
      contribution:
        values.contributionAmount.trim() === "" || !(Number(values.contributionAmount) > 0)
          ? null
          : {
              amount: Number(values.contributionAmount),
              frequency: values.contributionFrequency,
              growthRatePct: Number(values.contributionGrowthRatePct) || 0,
              payrollDeducted: values.contributionFunding === "paycheck",
              endDate: values.contributionEndDate.trim() === "" ? null : values.contributionEndDate,
            },
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
                  <Field label="Stop contributing on (optional)">
                    <TextInput reg={register("contributionEndDate")} type="date" />
                  </Field>
                  <p className="mt-1 text-xs text-dim">
                    Leave blank to stop automatically when the account&rsquo;s owner retires (a paycheck deduction
                    can&rsquo;t outlive the paycheck). Set a date to stop sooner, or to cap a joint account with no
                    single retiree.
                  </p>
                </>
              )}
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
