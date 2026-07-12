"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { IncomeCategory, IncomeSource, Person, RecurrenceFrequency, Account, TemporaryAdjustment } from "@/domain";
import { incomeSourceSchema } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
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
  amount: number;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string;
  growthRatePct: number;
  intervalYears: string;
  depositAccountId: string;
  category: IncomeCategory;
  isExcluded: boolean;
}

function toFormValues(income?: IncomeSource): FormValues {
  return {
    name: income?.name ?? "",
    ownerId: income?.ownerId ?? "",
    amount: income?.amount ?? 0,
    frequency: income?.frequency ?? "monthly",
    startDate: income?.startDate ?? "",
    endDate: income?.endDate ?? "",
    growthRatePct: income?.growthRatePct ?? 0,
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

  const { register, handleSubmit, watch } = useForm<FormValues>({
    defaultValues: toFormValues(income),
  });
  const category = watch("category");

  const onSubmit = (values: FormValues) => {
    const candidate = {
      name: values.name.trim(),
      ownerId: values.ownerId || null,
      amount: Number(values.amount),
      frequency: values.frequency,
      startDate: values.startDate,
      endDate: values.endDate || null,
      growthRatePct: Number(values.growthRatePct) || 0,
      intervalYears: values.intervalYears.trim() !== "" ? Number(values.intervalYears) : undefined,
      depositAccountId: values.depositAccountId,
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
          label={
            category === "social_security" || category === "pension"
              ? "Amount (per occurrence, today's dollars, GROSS -- before tax)"
              : "Amount (per occurrence, today's dollars)"
          }
        >
          <TextInput reg={register("amount", { valueAsNumber: true, required: true })} type="number" step="0.01" />
        </Field>
        {(category === "social_security" || category === "pension") && (
          <p className="-mt-1 text-xs text-dim">
            Unlike other income categories (entered take-home), {category === "social_security" ? "Social Security" : "pension"}{" "}
            should be the gross benefit -- what&rsquo;s on your SSA statement{category === "pension" ? " or pension paperwork" : ""},
            before any tax withholding. The engine computes real tax on it each year (Social Security only as far as it&rsquo;s
            actually taxable) rather than taking it as already net.
          </p>
        )}
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
          <SelectInput reg={register("depositAccountId", { required: true })} options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        <Field label="Start Date">
          <TextInput reg={register("startDate", { required: true })} type="date" />
        </Field>
        <Field label="End Date (optional -- leave blank to continue indefinitely)">
          <TextInput reg={register("endDate")} type="date" />
        </Field>
        <Field label="Annual Growth Rate (actual, e.g. 0.05 for 5%/yr raises incl. inflation)">
          <TextInput reg={register("growthRatePct", { valueAsNumber: true })} type="number" step="0.001" />
        </Field>
        {category === "social_security" && (
          <p className="-mt-1 text-xs text-dim">
            This grows once per year (a COLA), not continuously like a paycheck. Enter your inflation assumption
            (e.g. 0.03) to keep the benefit flat in today&rsquo;s-dollars terms, or a smaller rate to model a
            reduced COLA.
          </p>
        )}

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
