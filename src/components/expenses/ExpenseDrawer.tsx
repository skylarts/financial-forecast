"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import type { ExpenseCategory, ExpenseBaseline, RecurrenceFrequency, Account, TemporaryAdjustment } from "@/domain";
import { expenseBaselineSchema } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor } from "@/components/ui/AdjustmentsEditor";

const CATEGORY_OPTIONS: { value: ExpenseCategory; label: string }[] = [
  { value: "housing", label: "Housing" },
  { value: "transportation", label: "Transportation" },
  { value: "food", label: "Food" },
  { value: "healthcare", label: "Healthcare" },
  { value: "childcare", label: "Childcare" },
  { value: "discretionary", label: "Discretionary" },
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
  amount: number;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string;
  growthRatePct: number;
  intervalYears: string;
  paymentAccountId: string;
  category: ExpenseCategory;
  isExcluded: boolean;
}

function toFormValues(expense?: ExpenseBaseline): FormValues {
  return {
    name: expense?.name ?? "",
    amount: expense?.amount ?? 0,
    frequency: expense?.frequency ?? "monthly",
    startDate: expense?.startDate ?? "",
    endDate: expense?.endDate ?? "",
    growthRatePct: expense?.growthRatePct ?? 0,
    intervalYears: expense?.intervalYears?.toString() ?? "",
    paymentAccountId: expense?.paymentAccountId ?? "",
    category: expense?.category ?? "other",
    isExcluded: expense?.isExcluded ?? false,
  };
}

export function ExpenseDrawer({
  open,
  onClose,
  expense,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  expense?: ExpenseBaseline;
  accounts: Account[];
}) {
  const addExpense = usePlanStore((s) => s.addExpense);
  const updateExpense = usePlanStore((s) => s.updateExpense);
  const removeExpense = usePlanStore((s) => s.removeExpense);
  const [error, setError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<TemporaryAdjustment[]>(expense?.adjustments ?? []);
  const [advancedOpen, setAdvancedOpen] = useState(
    !!expense && ((expense.adjustments?.length ?? 0) > 0 || expense.isExcluded === true)
  );

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: toFormValues(expense),
  });

  const onSubmit = (values: FormValues) => {
    const candidate = {
      name: values.name.trim(),
      amount: Number(values.amount),
      frequency: values.frequency,
      startDate: values.startDate,
      endDate: values.endDate || null,
      growthRatePct: Number(values.growthRatePct) || 0,
      intervalYears: values.intervalYears.trim() !== "" ? Number(values.intervalYears) : undefined,
      paymentAccountId: values.paymentAccountId === "" ? null : values.paymentAccountId,
      category: values.category,
      adjustments,
      isExcluded: values.isExcluded,
    };

    const result = expenseBaselineSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid expense.");
      return;
    }

    if (expense) updateExpense(expense.id, result.data);
    else addExpense(result.data);
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title={expense ? "Edit Expense" : "Add Expense"}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Rent" />
        </Field>
        <Field label="Amount" hint="Per occurrence, today's dollars.">
          <TextInput reg={register("amount", { valueAsNumber: true, required: true })} type="number" step="0.01" />
        </Field>
        <Field label="Frequency">
          <SelectInput reg={register("frequency")} options={FREQUENCIES} />
        </Field>
        <Field
          label="Or repeat every N years (optional)"
          hint="For a repeat purchase like a car every few years. Overrides the Frequency above."
        >
          <TextInput reg={register("intervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
        </Field>
        <Field label="Category">
          <SelectInput reg={register("category")} options={CATEGORY_OPTIONS} />
        </Field>
        <Field label="Payment Account">
          <SelectInput
            reg={register("paymentAccountId")}
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
        <Field label="Annual Growth Rate (e.g. 0.03 to track inflation)" hint="Actual rate, not just inflation.">
          <TextInput reg={register("growthRatePct", { valueAsNumber: true })} type="number" step="0.001" />
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
              helpText="A temporary scale-up or scale-down over a date range (e.g. a rent hike: multiplier 1.2)."
            />
            <CheckboxInput
              reg={register("isExcluded")}
              label="Excluded (kept visible for reference, no effect on the projection)"
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          {expense ? (
            <button
              type="button"
              onClick={() => {
                removeExpense(expense.id);
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
              {expense ? "Save" : "Add Expense"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
