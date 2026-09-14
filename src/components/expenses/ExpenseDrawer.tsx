"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { DateAnchor, ExpenseCategory, ExpenseBaseline, RecurrenceFrequency, Account, TemporaryAdjustment } from "@/domain";
import { expenseBaselineSchema } from "@/domain";
import type { ResolvedExpenseSeed } from "@/lib/lifeEventTemplates";
import { Drawer } from "@/components/ui/Drawer";
import {
  AdvancedDisclosure,
  DrawerFooter,
  ErrorBanner,
  Field,
  FieldNote,
  FieldRow,
  FREQUENCY_OPTIONS,
  MoneyInput,
  PercentInput,
  SelectInput,
  CheckboxInput,
  TextInput,
  implausibleRateMessage,
  missingFieldMessage,
} from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { accountOptions } from "@/lib/people";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor, adjustmentsIssue } from "@/components/ui/AdjustmentsEditor";
import { AnchoredDateInput } from "@/components/ui/AnchoredDate";
import { ANCHOR_HINT } from "@/components/ui/formFields";

const CATEGORY_OPTIONS: { value: ExpenseCategory; label: string }[] = [
  { value: "housing", label: "Housing" },
  { value: "transportation", label: "Transportation" },
  { value: "food", label: "Food" },
  { value: "healthcare", label: "Healthcare" },
  { value: "childcare", label: "Childcare" },
  { value: "discretionary", label: "Discretionary" },
  { value: "other", label: "Other" },
];

const REQUIRED_LABELS = { name: "a name", amount: "an amount", startDate: "a start date" };

interface FormValues {
  name: string;
  /** Money string ("6,500"). */
  amount: string;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string;
  /** Percent string ("3" = 3%/yr); blank = matches inflation. */
  growthRatePct: string;
  intervalYears: string;
  paymentAccountId: string;
  /** Blank until the user picks one -- everything below is hidden until then. */
  category: ExpenseCategory | "";
  isExcluded: boolean;
}

function toFormValues(expense?: ExpenseBaseline, seed?: ResolvedExpenseSeed): FormValues {
  // A life-event template seeds a NEW expense: everything but the amount is
  // filled in, so the person types one number. Never applied when editing.
  if (!expense && seed) {
    return {
      name: seed.name,
      amount: "",
      frequency: seed.frequency,
      startDate: seed.startDate,
      endDate: seed.endDate ?? "",
      growthRatePct: fractionToPercentStr(seed.growthRatePct),
      intervalYears: seed.intervalYears?.toString() ?? "",
      paymentAccountId: seed.paymentAccountId ?? "",
      category: seed.category,
      isExcluded: false,
    };
  }
  return {
    name: expense?.name ?? "",
    amount: expense ? moneyToStr(expense.amount) : "",
    frequency: expense?.frequency ?? "monthly",
    startDate: expense?.startDate ?? "",
    endDate: expense?.endDate ?? "",
    growthRatePct: fractionToPercentStr(expense?.growthRatePct),
    intervalYears: expense?.intervalYears?.toString() ?? "",
    paymentAccountId: expense?.paymentAccountId ?? "",
    category: expense?.category ?? "",
    isExcluded: expense?.isExcluded ?? false,
  };
}

export function ExpenseDrawer({
  open,
  onClose,
  expense,
  accounts,
  seed,
}: {
  open: boolean;
  onClose: () => void;
  expense?: ExpenseBaseline;
  accounts: Account[];
  /** A life-event template's pre-filled values for a NEW expense (ignored when editing). */
  seed?: ResolvedExpenseSeed;
}) {
  const addExpense = usePlanStore((s) => s.addExpense);
  const updateExpense = usePlanStore((s) => s.updateExpense);
  const removeExpense = usePlanStore((s) => s.removeExpense);
  const people = usePlanStore((s) => s.activeScenario().household.people);
  const healthcareModelOn = usePlanStore((s) => s.activeScenario().settings.healthcare.enabled);
  const [error, setError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<TemporaryAdjustment[]>(expense?.adjustments ?? []);
  const [adjustmentsKey, setAdjustmentsKey] = useState(() => JSON.stringify(expense?.adjustments ?? []));
  // Structured values that live outside react-hook-form, like `adjustments`.
  const seedStartAnchor = () => expense?.startAnchor ?? (expense ? null : seed?.startAnchor ?? null);
  const seedEndAnchor = () => expense?.endAnchor ?? (expense ? null : seed?.endAnchor ?? null);
  const [startAnchor, setStartAnchor] = useState<DateAnchor | null>(seedStartAnchor);
  const [endAnchor, setEndAnchor] = useState<DateAnchor | null>(seedEndAnchor);
  const [anchorsKey, setAnchorsKey] = useState(() => JSON.stringify([expense?.startAnchor ?? null, expense?.endAnchor ?? null]));
  const [advancedOpen, setAdvancedOpen] = useState(
    !!expense && ((expense.adjustments?.length ?? 0) > 0 || expense.isExcluded === true)
  );
  const inflationRatePct = usePlanStore((s) => s.activeScenario().settings.inflationRatePct);
  const inflationPctLabel = fractionToPercentStr(inflationRatePct) || "0";

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { isDirty },
  } = useForm<FormValues>({
    defaultValues: toFormValues(expense, seed),
  });
  const category = watch("category");
  const isOneTime = watch("frequency") === "one_time";
  const dirty = isDirty || JSON.stringify(adjustments) !== adjustmentsKey || JSON.stringify([startAnchor, endAnchor]) !== anchorsKey;

  // Re-sync the form whenever the drawer opens on a different expense --
  // without this, a reused drawer instance shows the previous item's values.
  useEffect(() => {
    reset(toFormValues(expense, seed));
    setAdjustments(expense?.adjustments ?? []);
    setAdjustmentsKey(JSON.stringify(expense?.adjustments ?? []));
    setStartAnchor(seedStartAnchor());
    setEndAnchor(seedEndAnchor());
    setAnchorsKey(JSON.stringify([expense?.startAnchor ?? null, expense?.endAnchor ?? null]));
    setError(null);
    setAdvancedOpen(!!expense && ((expense.adjustments?.length ?? 0) > 0 || expense.isExcluded === true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expense, open, reset, seed]);

  const onSubmit = (values: FormValues) => {
    if (!values.category) {
      setError("Select a category.");
      return;
    }
    const growth = percentStrToFraction(values.growthRatePct);
    const rateIssue = implausibleRateMessage("The growth rate", growth);
    if (rateIssue) {
      setError(rateIssue);
      return;
    }
    const amount = moneyStrToNumber(values.amount) ?? 0;
    if (amount <= 0) {
      setError("The amount needs to be more than zero.");
      return;
    }
    const adjIssue = adjustmentsIssue(adjustments);
    if (adjIssue) {
      setError(adjIssue);
      setAdvancedOpen(true);
      return;
    }
    const candidate = {
      name: values.name.trim(),
      amount,
      frequency: values.frequency,
      startDate: values.startDate,
      endDate: values.frequency === "one_time" ? null : values.endDate || null,
      startAnchor,
      // A one-time expense has no end date, so it can have no end link either.
      endAnchor: values.frequency === "one_time" ? null : endAnchor,
      growthRatePct: growth,
      // A one-time item is one-time: never carry a hidden repeat interval.
      intervalYears: values.frequency !== "one_time" && values.intervalYears.trim() !== "" ? Number(values.intervalYears) : undefined,
      paymentAccountId: values.paymentAccountId === "" ? null : values.paymentAccountId,
      category: values.category,
      adjustments,
      isExcluded: values.isExcluded,
      // Display only -- see IncomeDrawer.
      templateId: expense?.templateId ?? seed?.templateId,
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

  const onInvalid = (errors: Record<string, unknown>) => setError(missingFieldMessage(errors, REQUIRED_LABELS));

  return (
    <Drawer open={open} onClose={onClose} title={expense ? "Edit Expense" : "Add Expense"} dirty={dirty}>
      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        {!expense && seed?.note && <FieldNote tone="info">{seed.note} Change anything below.</FieldNote>}
        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Rent" />
        </Field>
        <Field label="Category">
          <SelectInput
            reg={register("category")}
            options={expense ? CATEGORY_OPTIONS : [{ value: "", label: "Select a category..." }, ...CATEGORY_OPTIONS]}
          />
          {category === "healthcare" && healthcareModelOn && (
            <FieldNote>
              The healthcare model (Assumptions) already charges premiums, Medicare and out-of-pocket costs. Enter here only what it does not cover.
            </FieldNote>
          )}
        </Field>
        {category !== "" && (
          <>
            <Field label="Amount" hint="Per occurrence, today's dollars.">
              <MoneyInput reg={register("amount", { required: true })} placeholder="e.g. 6,500" />
            </Field>
            {/* Alternatives, not independent settings -- the second overrides the
                first -- so "Or" sits beside what it is an alternative to. */}
            {isOneTime ? (
              <Field label="Frequency">
                <SelectInput reg={register("frequency")} options={FREQUENCY_OPTIONS} />
              </Field>
            ) : (
              <FieldRow>
                <Field label="Frequency">
                  <SelectInput reg={register("frequency")} options={FREQUENCY_OPTIONS} />
                </Field>
                <Field label="Or every N years" hint="Optional. For a repeat purchase like a car every few years. Overrides the Frequency.">
                  <TextInput reg={register("intervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
                </Field>
              </FieldRow>
            )}
            {isOneTime ? (
              <Field label="Date" hint={ANCHOR_HINT}>
                <AnchoredDateInput
                  reg={register("startDate", { required: true })}
                  anchor={startAnchor}
                  onAnchorChange={setStartAnchor}
                  onResolve={(d) => setValue("startDate", d, { shouldDirty: true })}
                  people={people}
                  kind="start"
                />
              </Field>
            ) : (
              <FieldRow>
                <Field label="Start Date" hint={ANCHOR_HINT}>
                  <AnchoredDateInput
                    reg={register("startDate", { required: true })}
                    anchor={startAnchor}
                    onAnchorChange={setStartAnchor}
                    onResolve={(d) => setValue("startDate", d, { shouldDirty: true })}
                    people={people}
                    kind="start"
                  />
                </Field>
                <Field
                  label="End Date"
                  hint="Optional -- leave blank to continue indefinitely. Link it to a retirement (a pre-Medicare healthcare bridge, a mortgage you mean to clear) and the last payment lands the day before."
                >
                  <AnchoredDateInput
                    reg={register("endDate")}
                    anchor={endAnchor}
                    onAnchorChange={setEndAnchor}
                    onResolve={(d) => setValue("endDate", d, { shouldDirty: true })}
                    people={people}
                    kind="end"
                  />
                </Field>
              </FieldRow>
            )}
            <Field label="Payment Account">
              <SelectInput
                reg={register("paymentAccountId")}
                options={[
                  { value: "", label: "Extra Savings (Default)" },
                  // Paying an expense FROM a loan is borrowing, and from a home
                  // is meaningless: only spendable asset accounts are offered.
                  ...accountOptions(
                    accounts.filter((a) => !a.isExtraSavings && a.category === "asset" && a.class !== "real_estate"),
                    people
                  ),
                ]}
              />
            </Field>
            {!isOneTime && (
              <Field
                label="Annual Growth Rate"
                hint={`Percent per year, e.g. 3 for 3%. Blank = matches your inflation assumption (${inflationPctLabel}%), keeping the expense flat in today's dollars -- the right default for most living expenses. 0 = flat in nominal terms (quietly shrinks in real terms over decades).`}
              >
                <PercentInput reg={register("growthRatePct")} placeholder={`blank = inflation (${inflationPctLabel}%)`} />
              </Field>
            )}

            <AdvancedDisclosure open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
              {!isOneTime && (
                <AdjustmentsEditor
                  adjustments={adjustments}
                  onChange={setAdjustments}
                  helpText="A temporary scale-up or scale-down over a date range (a rent hike: +20)."
                />
              )}
              <CheckboxInput reg={register("isExcluded")} label="Excluded (kept visible for reference, no effect on the projection)" />
            </AdvancedDisclosure>
          </>
        )}

        <DrawerFooter
          submitLabel={expense ? "Save" : "Add Expense"}
          onDelete={
            expense
              ? () => {
                  removeExpense(expense.id);
                  onClose();
                }
              : undefined
          }
          deleteConfirmText={`Delete ${expense?.name ?? "this expense"}? You can undo from the toast afterwards.`}
        />
      </form>
    </Drawer>
  );
}
