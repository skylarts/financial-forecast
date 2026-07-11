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
  { value: "tax_deferred", label: "Tax-deferred (401k/IRA)" },
  { value: "tax_free", label: "Tax-free (Roth)" },
  { value: "other_asset", label: "Other Asset" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan" },
];

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
  isSpendingAccount: boolean;
  targetCashBalance: string;
  isSurplusTarget: boolean;
  surplusTargetPriority: string;
  maxBalance: string;
  maxBalanceGrowthRatePct: string;
  withdrawalPriority: string;
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
    isSpendingAccount: account?.isSpendingAccount ?? false,
    targetCashBalance: account?.targetCashBalance?.toString() ?? "",
    isSurplusTarget: account?.isSurplusTarget ?? false,
    surplusTargetPriority: account?.surplusTargetPriority?.toString() ?? "",
    maxBalance: account?.maxBalance?.toString() ?? "",
    maxBalanceGrowthRatePct: account?.maxBalanceGrowthRatePct?.toString() ?? "",
    withdrawalPriority: account?.withdrawalPriority?.toString() ?? "",
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

  const { register, handleSubmit, reset, watch } = useForm<FormValues>({
    defaultValues: toFormValues(account),
  });

  useEffect(() => {
    reset(toFormValues(account));
    setError(null);
  }, [account, open, reset]);

  const selectedClass = watch("class");
  const isSpendingAccount = watch("isSpendingAccount");
  const isSurplusTarget = watch("isSurplusTarget");
  const contributionAmount = watch("contributionAmount");
  const contributionFunding = watch("contributionFunding");

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
      linkedExternally: false,
      withdrawalPriority: values.withdrawalPriority === "" ? null : Number(values.withdrawalPriority),
      isSpendingAccount: values.isSpendingAccount,
      targetCashBalance: values.targetCashBalance.trim() === "" ? null : Number(values.targetCashBalance),
      isSurplusTarget: values.isSurplusTarget,
      surplusTargetPriority: values.surplusTargetPriority === "" ? null : Number(values.surplusTargetPriority),
      maxBalance: values.maxBalance.trim() === "" ? null : Number(values.maxBalance),
      maxBalanceGrowthRatePct:
        values.maxBalanceGrowthRatePct.trim() === "" ? null : Number(values.maxBalanceGrowthRatePct),
      taxTreatment: values.taxTreatment,
      subjectToRMD: values.subjectToRMD,
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
        <Field label="Owner">
          <SelectInput
            reg={register("ownerId")}
            options={[{ value: "", label: "Joint / none" }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>
        <Field label="Starting Balance">
          <TextInput reg={register("startingBalance", { valueAsNumber: true })} type="number" step="0.01" />
        </Field>
        <Field label="Annual Growth Rate (e.g. 0.07 for 7%)">
          <TextInput reg={register("growthRatePct", { valueAsNumber: true })} type="number" step="0.001" />
        </Field>
        <Field label="Tax Treatment">
          <SelectInput reg={register("taxTreatment")} options={TAX_TREATMENT_OPTIONS} />
        </Field>
        {selectedClass === "tax_deferred" && (
          <CheckboxInput reg={register("subjectToRMD")} label="Subject to RMDs (age 73+)" />
        )}
        <CheckboxInput reg={register("isSpendingAccount")} label="Spending account (deficits covered here first)" />
        {isSpendingAccount && (
          <>
            <Field label="Target cash balance (buffer to keep before sweeping surplus, optional)">
              <TextInput reg={register("targetCashBalance")} type="number" step="0.01" placeholder="e.g. 10000" />
            </Field>
            <p className="-mt-1 text-xs text-dim">
              Surplus is only swept to your savings/investments once this account is above the buffer. Entered in
              today&rsquo;s dollars and grown with inflation. Leave blank to sweep every dollar each month.
            </p>
          </>
        )}
        <Field label="Withdrawal Priority (lower = drawn first, optional)">
          <TextInput reg={register("withdrawalPriority")} type="number" placeholder="e.g. 1" />
        </Field>
        <CheckboxInput reg={register("isSurplusTarget")} label="Surplus target (receives routed surplus cash)" />
        {isSurplusTarget && (
          <>
            <Field label="Surplus Target Priority (lower = filled first, optional)">
              <TextInput reg={register("surplusTargetPriority")} type="number" placeholder="e.g. 1" />
            </Field>
            <Field label="Max Balance (cap, blank = no cap / absorbs everything)">
              <TextInput reg={register("maxBalance")} type="number" step="0.01" placeholder="e.g. 25000" />
            </Field>
            <Field label="Max Balance Growth Rate (blank = follow inflation, 0 = hold flat)">
              <TextInput reg={register("maxBalanceGrowthRatePct")} type="number" step="0.001" placeholder="e.g. 0.03" />
            </Field>
            <p className="-mt-1 text-xs text-dim">
              Surplus fills this account only up to its cap, then spills to the next-priority target. Leave the
              lowest-priority account uncapped as a catch-all. The cap grows each year by its growth rate (defaulting to
              your inflation assumption) so it keeps pace over time.
            </p>
          </>
        )}
        <div className="mt-1 rounded-md border border-border p-3">
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
                can&rsquo;t outlive the paycheck). Set a date to stop sooner, or to cap a joint account with no single
                retiree.
              </p>
            </>
          )}
        </div>

        <CheckboxInput reg={register("isExcluded")} label="Excluded from the plan" />

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
