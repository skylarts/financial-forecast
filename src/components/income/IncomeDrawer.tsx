"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { IncomeCategory, IncomeSource, Person, RecurrenceFrequency, Account, TemporaryAdjustment } from "@/domain";
import { incomeSourceSchema } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, PercentInput, MoneyInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor } from "@/components/ui/AdjustmentsEditor";

const CATEGORY_OPTIONS: { value: IncomeCategory; label: string }[] = [
  { value: "salary", label: "Salary" },
  { value: "social_security", label: "Social Security" },
  { value: "pension", label: "Pension" },
  { value: "rental", label: "Rental" },
  { value: "other", label: "Other" },
];

const FREQUENCIES: { value: RecurrenceFrequency; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "weekly", label: "Weekly" },
  { value: "annual", label: "Annual" },
  { value: "one_time", label: "One time" },
];

interface FormValues {
  name: string;
  ownerId: string;
  /** Money string ("7,500"). */
  amount: string;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string;
  /** Percent string ("5" = 5%/yr); blank = matches inflation. */
  growthRatePct: string;
  intervalYears: string;
  depositAccountId: string;
  category: IncomeCategory;
  isExcluded: boolean;
}

function toFormValues(income?: IncomeSource): FormValues {
  return {
    name: income?.name ?? "",
    ownerId: income?.ownerId ?? "",
    amount: income ? moneyToStr(income.amount) : "",
    frequency: income?.frequency ?? "monthly",
    startDate: income?.startDate ?? "",
    endDate: income?.endDate ?? "",
    growthRatePct: fractionToPercentStr(income?.growthRatePct),
    intervalYears: income?.intervalYears?.toString() ?? "",
    depositAccountId: income?.depositAccountId ?? "",
    category: income?.category ?? "salary",
    isExcluded: income?.isExcluded ?? false,
  };
}

export function IncomeDrawer({
  open,
  onClose,
  income,
  people,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  income?: IncomeSource;
  people: Person[];
  accounts: Account[];
}) {
  const addIncomeSource = usePlanStore((s) => s.addIncomeSource);
  const updateIncomeSource = usePlanStore((s) => s.updateIncomeSource);
  const removeIncomeSource = usePlanStore((s) => s.removeIncomeSource);
  const [error, setError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<TemporaryAdjustment[]>(income?.adjustments ?? []);
  const [advancedOpen, setAdvancedOpen] = useState(
    !!income && ((income.adjustments?.length ?? 0) > 0 || income.isExcluded === true)
  );
  const inflationRatePct = usePlanStore((s) => s.activeScenario().settings.inflationRatePct);
  const inflationPctLabel = fractionToPercentStr(inflationRatePct) || "0";

  const { register, handleSubmit, watch, reset } = useForm<FormValues>({
    defaultValues: toFormValues(income),
  });
  const category = watch("category");

  // Re-sync the form whenever the drawer opens on a different income item --
  // without this, a reused drawer instance shows the previous item's values.
  useEffect(() => {
    reset(toFormValues(income));
    setAdjustments(income?.adjustments ?? []);
    setError(null);
    setAdvancedOpen(!!income && ((income.adjustments?.length ?? 0) > 0 || income.isExcluded === true));
  }, [income, open, reset]);

  const onSubmit = (values: FormValues) => {
    const candidate = {
      name: values.name.trim(),
      ownerId: values.ownerId || null,
      amount: moneyStrToNumber(values.amount) ?? 0,
      frequency: values.frequency,
      startDate: values.startDate,
      endDate: values.endDate || null,
      growthRatePct: percentStrToFraction(values.growthRatePct),
      intervalYears: values.intervalYears.trim() !== "" ? Number(values.intervalYears) : undefined,
      depositAccountId: values.depositAccountId === "" ? null : values.depositAccountId,
      category: values.category,
      adjustments,
      isExcluded: values.isExcluded,
    };

    const result = incomeSourceSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid income source.");
      return;
    }

    if (income) updateIncomeSource(income.id, result.data);
    else addIncomeSource(result.data);
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title={income ? "Edit Income" : "Add Income"}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Alex Salary" />
        </Field>
        <Field label="Owner">
          <SelectInput
            reg={register("ownerId")}
            options={[{ value: "", label: "Joint / none" }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>
        <Field
          label={category === "social_security" || category === "pension" ? "Amount (GROSS, before tax)" : "Amount"}
          hint={
            category === "social_security" || category === "pension"
              ? `Per occurrence, today's dollars. Enter the gross benefit -- what's on your SSA statement${category === "pension" ? " or pension paperwork" : ""}, before withholding. The engine computes real tax on it each year.`
              : "Per occurrence, today's dollars."
          }
        >
          <MoneyInput reg={register("amount", { required: true })} placeholder="e.g. 7,500" />
        </Field>
        <Field label="Frequency">
          <SelectInput reg={register("frequency")} options={FREQUENCIES} />
        </Field>
        <Field label="Or repeat every N years (optional)">
          <TextInput reg={register("intervalYears")} type="number" min="1" step="1" placeholder="e.g. 10" />
        </Field>
        <Field label="Category">
          <SelectInput reg={register("category")} options={CATEGORY_OPTIONS} />
        </Field>
        <Field label="Deposit Account">
          <SelectInput
            reg={register("depositAccountId")}
            options={[
              { value: "", label: "Extra Savings (Default)" },
              ...accounts.filter((a) => !a.isExtraSavings).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </Field>
        <Field label="Start Date">
          <TextInput reg={register("startDate", { required: true })} type="date" />
        </Field>
        <Field label="End Date (optional)" hint="Leave blank to continue indefinitely.">
          <TextInput reg={register("endDate")} type="date" />
        </Field>
        <Field
          label="Annual Growth Rate"
          hint={
            category === "social_security"
              ? `Percent per year, e.g. 2.5 for a 2.5% COLA -- actual raises, including inflation. Social Security steps once each January, not continuously. Blank = matches your inflation assumption (${inflationPctLabel}%), keeping the benefit flat in today's dollars.`
              : `Percent per year, e.g. 5 for 5% -- actual raises, including inflation. Blank = matches your inflation assumption (${inflationPctLabel}%); 0 = flat in nominal terms (shrinks in real terms).`
          }
        >
          <PercentInput reg={register("growthRatePct")} placeholder={`blank = inflation (${inflationPctLabel}%)`} />
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
            <AdjustmentsEditor
              adjustments={adjustments}
              onChange={setAdjustments}
              helpText="A temporary raise, pause, or cut over a date range (e.g. a career break: multiplier 0)."
            />
            <CheckboxInput
              reg={register("isExcluded")}
              label="Excluded (kept visible for reference, no effect on the projection)"
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          {income ? (
            <button
              type="button"
              onClick={() => {
                removeIncomeSource(income.id);
                onClose();
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
              {income ? "Save" : "Add Income"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
