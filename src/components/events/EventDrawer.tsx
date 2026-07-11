"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type {
  Account,
  EventType,
  ExpenseBaseline,
  IncomeSource,
  Person,
  RecurrenceFrequency,
  ScenarioEvent,
} from "@/domain";
import {
  retireEventSchema,
  incomeChangeEventSchema,
  expenseChangeEventSchema,
  buyHomeEventSchema,
  socialSecurityStartEventSchema,
  haveAKidEventSchema,
  windfallEventSchema,
  customTransferEventSchema,
  growthRateChangeEventSchema,
} from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

const EVENT_TEMPLATES: { type: EventType; label: string; hint: string }[] = [
  { type: "retire", label: "Retire", hint: "Stop a person's salary income at a given date" },
  { type: "income_change", label: "Income change", hint: "Raise, pause, or scale an existing income source for a period" },
  { type: "expense_change", label: "Expense change", hint: "Scale an existing expense up or down for a period" },
  { type: "buy_home", label: "Buy a home", hint: "Creates a real estate asset, optionally financed" },
  { type: "social_security_start", label: "Social Security", hint: "Start a monthly benefit" },
  { type: "have_a_kid", label: "Have a kid", hint: "Childcare costs + optional one-time cost" },
  { type: "windfall", label: "Windfall", hint: "One-time or recurring inflow/outflow" },
  { type: "custom_transfer", label: "Custom transfer", hint: "Move money between two of your accounts" },
  { type: "growth_rate_change", label: "Change growth rate", hint: "Shift an account to a new rate of return, e.g. de-risking at retirement" },
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
  startDate: string;
  endDate: string;
  personId: string;
  retirementAge: string;
  targetId: string;
  multiplier: string;
  purchasePrice: string;
  downPaymentAmount: string;
  downPaymentFromAccountId: string;
  propertyGrowthRatePct: string;
  financed: boolean;
  mortgageRate: string;
  mortgageTermMonths: string;
  monthlyBenefitAmount: string;
  ssGrowthRatePct: string;
  ssDepositAccountId: string;
  childcareMonthlyExpense: string;
  childcareEndDate: string;
  additionalOneTimeCost: string;
  kidPaymentAccountId: string;
  windfallAmount: string;
  windfallDepositAccountId: string;
  isRecurring: boolean;
  windfallFrequency: RecurrenceFrequency;
  windfallIntervalYears: string;
  transferAmount: string;
  fromAccountId: string;
  toAccountId: string;
  transferFrequency: RecurrenceFrequency;
  transferGrowthRatePct: string;
  transferIntervalYears: string;
  growthChangeAccountId: string;
  growthChangeNewRatePct: string;
}

const DEFAULTS: FormValues = {
  name: "",
  startDate: "",
  endDate: "",
  personId: "",
  retirementAge: "",
  targetId: "",
  multiplier: "",
  purchasePrice: "",
  downPaymentAmount: "",
  downPaymentFromAccountId: "",
  propertyGrowthRatePct: "0.03",
  financed: true,
  mortgageRate: "0.06",
  mortgageTermMonths: "360",
  monthlyBenefitAmount: "",
  ssGrowthRatePct: "",
  ssDepositAccountId: "",
  childcareMonthlyExpense: "",
  childcareEndDate: "",
  additionalOneTimeCost: "",
  kidPaymentAccountId: "",
  windfallAmount: "",
  windfallDepositAccountId: "",
  isRecurring: false,
  windfallFrequency: "annual",
  windfallIntervalYears: "",
  transferAmount: "",
  fromAccountId: "",
  toAccountId: "",
  transferFrequency: "monthly",
  transferGrowthRatePct: "",
  transferIntervalYears: "",
  growthChangeAccountId: "",
  growthChangeNewRatePct: "",
};

function eventToFormValues(event: ScenarioEvent): FormValues {
  const base = { ...DEFAULTS, name: event.name, startDate: event.startDate, endDate: event.endDate ?? "" };
  switch (event.type) {
    case "retire":
      return { ...base, personId: event.personId, retirementAge: event.retirementAge?.toString() ?? "" };
    case "income_change":
    case "expense_change":
      return {
        ...base,
        targetId: event.type === "income_change" ? event.targetIncomeSourceId : event.targetExpenseId,
        multiplier: event.multiplier?.toString() ?? "",
      };
    case "buy_home":
      return {
        ...base,
        purchasePrice: event.purchasePrice.toString(),
        downPaymentAmount: event.downPaymentAmount.toString(),
        downPaymentFromAccountId: event.downPaymentFromAccountId,
        propertyGrowthRatePct: event.propertyGrowthRatePct.toString(),
        financed: event.mortgage !== null,
        mortgageRate: event.mortgage?.annualInterestRatePct.toString() ?? "0.06",
        mortgageTermMonths: event.mortgage?.termMonths.toString() ?? "360",
      };
    case "social_security_start":
      return {
        ...base,
        personId: event.personId,
        monthlyBenefitAmount: event.monthlyBenefitAmount.toString(),
        ssGrowthRatePct: event.growthRatePct?.toString() ?? "",
        ssDepositAccountId: event.depositAccountId,
      };
    case "have_a_kid":
      return {
        ...base,
        childcareMonthlyExpense: event.childcareMonthlyExpense.toString(),
        childcareEndDate: event.childcareEndDate ?? "",
        additionalOneTimeCost: event.additionalOneTimeCost?.toString() ?? "",
        kidPaymentAccountId: event.paymentAccountId,
      };
    case "windfall":
      return {
        ...base,
        windfallAmount: event.amount.toString(),
        windfallDepositAccountId: event.depositAccountId,
        isRecurring: event.isRecurring ?? false,
        windfallFrequency: event.frequency ?? "annual",
        windfallIntervalYears: event.intervalYears?.toString() ?? "",
      };
    case "custom_transfer":
      return {
        ...base,
        transferAmount: event.amount.toString(),
        fromAccountId: event.fromAccountId,
        toAccountId: event.toAccountId,
        transferFrequency: event.frequency,
        transferGrowthRatePct: event.growthRatePct?.toString() ?? "",
        transferIntervalYears: event.intervalYears?.toString() ?? "",
      };
    case "growth_rate_change":
      return {
        ...base,
        growthChangeAccountId: event.targetAccountId,
        growthChangeNewRatePct: event.newGrowthRatePct.toString(),
      };
  }
}

export function EventDrawer({
  open,
  onClose,
  event,
  accounts,
  people,
  incomeSources,
  expenses,
}: {
  open: boolean;
  onClose: () => void;
  event?: ScenarioEvent;
  accounts: Account[];
  people: Person[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
}) {
  const addEvent = usePlanStore((s) => s.addEvent);
  const updateEvent = usePlanStore((s) => s.updateEvent);
  const removeEvent = usePlanStore((s) => s.removeEvent);

  const [selectedType, setSelectedType] = useState<EventType | null>(event?.type ?? null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, watch, reset } = useForm<FormValues>({
    defaultValues: event ? eventToFormValues(event) : DEFAULTS,
  });

  useEffect(() => {
    setSelectedType(event?.type ?? null);
    reset(event ? eventToFormValues(event) : DEFAULTS);
    setError(null);
  }, [event, open, reset]);

  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));
  const personOptions = people.map((p) => ({ value: p.id, label: p.name }));
  const financed = watch("financed");
  const isRecurring = watch("isRecurring");

  const onSubmit = (v: FormValues) => {
    if (!selectedType) return;
    const base = { name: v.name.trim(), startDate: v.startDate, endDate: v.endDate || undefined };
    let candidate: unknown;
    let schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

    switch (selectedType) {
      case "retire":
        candidate = { ...base, type: "retire", personId: v.personId, retirementAge: v.retirementAge ? Number(v.retirementAge) : undefined };
        schema = retireEventSchema.omit({ id: true });
        break;
      case "income_change":
        candidate = {
          ...base,
          type: "income_change",
          targetIncomeSourceId: v.targetId,
          multiplier: v.multiplier ? Number(v.multiplier) : undefined,
        };
        schema = incomeChangeEventSchema.omit({ id: true });
        break;
      case "expense_change":
        candidate = {
          ...base,
          type: "expense_change",
          targetExpenseId: v.targetId,
          multiplier: v.multiplier ? Number(v.multiplier) : undefined,
        };
        schema = expenseChangeEventSchema.omit({ id: true });
        break;
      case "buy_home":
        candidate = {
          ...base,
          type: "buy_home",
          purchasePrice: Number(v.purchasePrice),
          downPaymentAmount: Number(v.downPaymentAmount),
          downPaymentFromAccountId: v.downPaymentFromAccountId,
          propertyGrowthRatePct: Number(v.propertyGrowthRatePct),
          mortgage: v.financed
            ? { annualInterestRatePct: Number(v.mortgageRate), termMonths: Number(v.mortgageTermMonths) }
            : null,
        };
        schema = buyHomeEventSchema.omit({ id: true });
        break;
      case "social_security_start":
        candidate = {
          ...base,
          type: "social_security_start",
          personId: v.personId,
          monthlyBenefitAmount: Number(v.monthlyBenefitAmount),
          growthRatePct: v.ssGrowthRatePct.trim() !== "" ? Number(v.ssGrowthRatePct) : undefined,
          depositAccountId: v.ssDepositAccountId,
        };
        schema = socialSecurityStartEventSchema.omit({ id: true });
        break;
      case "have_a_kid":
        candidate = {
          ...base,
          type: "have_a_kid",
          childcareMonthlyExpense: Number(v.childcareMonthlyExpense),
          childcareEndDate: v.childcareEndDate || null,
          additionalOneTimeCost: v.additionalOneTimeCost ? Number(v.additionalOneTimeCost) : undefined,
          paymentAccountId: v.kidPaymentAccountId,
        };
        schema = haveAKidEventSchema.omit({ id: true });
        break;
      case "windfall":
        candidate = {
          ...base,
          type: "windfall",
          amount: Number(v.windfallAmount),
          depositAccountId: v.windfallDepositAccountId,
          isRecurring: v.isRecurring,
          frequency: v.isRecurring ? v.windfallFrequency : undefined,
          intervalYears:
            v.isRecurring && v.windfallIntervalYears.trim() !== "" ? Number(v.windfallIntervalYears) : undefined,
        };
        schema = windfallEventSchema.omit({ id: true });
        break;
      case "custom_transfer":
        if (v.fromAccountId === v.toAccountId) {
          setError("From and To accounts must differ.");
          return;
        }
        candidate = {
          ...base,
          type: "custom_transfer",
          amount: Number(v.transferAmount),
          fromAccountId: v.fromAccountId,
          toAccountId: v.toAccountId,
          frequency: v.transferFrequency,
          growthRatePct: v.transferGrowthRatePct ? Number(v.transferGrowthRatePct) : undefined,
          intervalYears: v.transferIntervalYears.trim() !== "" ? Number(v.transferIntervalYears) : undefined,
        };
        schema = customTransferEventSchema.omit({ id: true });
        break;
      case "growth_rate_change":
        candidate = {
          ...base,
          type: "growth_rate_change",
          targetAccountId: v.growthChangeAccountId,
          newGrowthRatePct: Number(v.growthChangeNewRatePct),
        };
        schema = growthRateChangeEventSchema.omit({ id: true });
        break;
    }

    const result = schema.safeParse(candidate);
    if (!result.success) {
      setError(result.error?.issues[0]?.message ?? "Invalid event.");
      return;
    }
    if (event) updateEvent(event.id, result.data as Omit<ScenarioEvent, "id">);
    else addEvent(result.data as Omit<ScenarioEvent, "id">);
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title={event ? "Edit Event" : "Add Event"}>
      {!selectedType ? (
        <div className="flex flex-col gap-2">
          {EVENT_TEMPLATES.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => setSelectedType(t.type)}
              className="rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent"
            >
              <div className="text-sm font-medium">{t.label}</div>
              <div className="text-xs text-dim">{t.hint}</div>
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
          <ErrorBanner message={error} />
          <Field label="Name">
            <TextInput reg={register("name", { required: true })} />
          </Field>
          <Field label="Start Date">
            <TextInput reg={register("startDate", { required: true })} type="date" />
          </Field>

          {selectedType === "retire" && (
            <>
              <Field label="Person">
                <SelectInput reg={register("personId")} options={personOptions} />
              </Field>
              <Field label="Retirement Age (optional override)">
                <TextInput reg={register("retirementAge")} type="number" />
              </Field>
            </>
          )}

          {(selectedType === "income_change" || selectedType === "expense_change") && (
            <>
              <p className="-mt-1 text-xs text-dim">
                To add a brand-new income source or expense (including one starting on a future date), use
                &quot;+ Add Income&quot; / &quot;+ Add Expense&quot; on the Income &amp; Expenses tab instead. This event only
                modifies one that already exists.
              </p>
              <Field label={selectedType === "income_change" ? "Target Income Source" : "Target Expense"}>
                <SelectInput
                  reg={register("targetId", { required: true })}
                  options={(selectedType === "income_change" ? incomeSources : expenses).map((x) => ({
                    value: x.id,
                    label: x.name,
                  }))}
                />
              </Field>
              <Field label="Multiplier (e.g. 0 = pause, 0.5 = half, 1.03 = 3% bump)">
                <TextInput reg={register("multiplier")} type="number" step="0.01" />
              </Field>
              <Field label="End Date (leave blank for permanent)">
                <TextInput reg={register("endDate")} type="date" />
              </Field>
            </>
          )}

          {selectedType === "buy_home" && (
            <>
              <Field label="Purchase Price (today's dollars)">
                <TextInput reg={register("purchasePrice", { required: true })} type="number" step="0.01" />
              </Field>
              <Field label="Down Payment (today's dollars)">
                <TextInput reg={register("downPaymentAmount", { required: true })} type="number" step="0.01" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Both are inflated from today to the purchase date by the same factor, so the down payment stays the
                same share of the purchase price.
              </p>
              <Field label="Down Payment From">
                <SelectInput reg={register("downPaymentFromAccountId", { required: true })} options={accountOptions} />
              </Field>
              <Field label="Annual Property Growth Rate">
                <TextInput reg={register("propertyGrowthRatePct")} type="number" step="0.001" />
              </Field>
              <CheckboxInput reg={register("financed")} label="Financed with a mortgage" />
              {financed && (
                <>
                  <Field label="Mortgage Rate">
                    <TextInput reg={register("mortgageRate")} type="number" step="0.001" />
                  </Field>
                  <Field label="Term (months)">
                    <TextInput reg={register("mortgageTermMonths")} type="number" />
                  </Field>
                </>
              )}
            </>
          )}

          {selectedType === "social_security_start" && (
            <>
              <Field label="Person">
                <SelectInput reg={register("personId")} options={personOptions} />
              </Field>
              <Field label="Monthly Benefit (today's dollars)">
                <TextInput reg={register("monthlyBenefitAmount", { required: true })} type="number" step="0.01" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Enter the future benefit in today's dollars. It's automatically grown to future
                (nominal) dollars by the COLA below, so Real view shows it back in today's-dollars terms.
              </p>
              <Field label="Annual COLA / growth rate (optional)">
                <TextInput reg={register("ssGrowthRatePct")} type="number" step="0.001" placeholder="blank = match inflation" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                How the benefit grows each year. Leave blank to track your inflation assumption (the usual
                cost-of-living adjustment); enter a rate like 0.02 to model a smaller COLA.
              </p>
              <Field label="Deposit Account">
                <SelectInput reg={register("ssDepositAccountId", { required: true })} options={accountOptions} />
              </Field>
            </>
          )}

          {selectedType === "have_a_kid" && (
            <>
              <Field label="Monthly Childcare Expense (today's dollars)">
                <TextInput reg={register("childcareMonthlyExpense", { required: true })} type="number" step="0.01" />
              </Field>
              <Field label="Childcare End Date (optional)">
                <TextInput reg={register("childcareEndDate")} type="date" />
              </Field>
              <Field label="One-time Cost (today's dollars, optional)">
                <TextInput reg={register("additionalOneTimeCost")} type="number" step="0.01" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Both are automatically inflated from today to when they occur.
              </p>
              <Field label="Payment Account">
                <SelectInput reg={register("kidPaymentAccountId", { required: true })} options={accountOptions} />
              </Field>
            </>
          )}

          {selectedType === "windfall" && (
            <>
              <Field label="Amount (today's dollars; negative = one-time expense)">
                <TextInput reg={register("windfallAmount", { required: true })} type="number" step="0.01" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Automatically inflated from today to whenever this occurs (each recurrence, if repeating).
              </p>
              <Field label="Account">
                <SelectInput reg={register("windfallDepositAccountId", { required: true })} options={accountOptions} />
              </Field>
              <CheckboxInput reg={register("isRecurring")} label="Recurring" />
              {isRecurring && (
                <>
                  <Field label="Frequency">
                    <SelectInput reg={register("windfallFrequency")} options={FREQUENCIES.filter((f) => f.value !== "one_time")} />
                  </Field>
                  <Field label="Or repeat every N years (optional)">
                    <TextInput reg={register("windfallIntervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
                  </Field>
                  <p className="-mt-1 text-xs text-dim">
                    Set this for something like a car you replace on a cycle. When filled, it repeats every N years from
                    the start date and overrides the frequency above.
                  </p>
                </>
              )}
            </>
          )}

          {selectedType === "custom_transfer" && (
            <>
              <Field label="Amount (per occurrence, today's dollars)">
                <TextInput reg={register("transferAmount", { required: true })} type="number" step="0.01" />
              </Field>
              <Field label="From Account">
                <SelectInput reg={register("fromAccountId", { required: true })} options={accountOptions} />
              </Field>
              <Field label="To Account">
                <SelectInput reg={register("toAccountId", { required: true })} options={accountOptions} />
              </Field>
              <Field label="Frequency">
                <SelectInput reg={register("transferFrequency")} options={FREQUENCIES} />
              </Field>
              <Field label="Or repeat every N years (optional)">
                <TextInput reg={register("transferIntervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                For a repeat purchase like a car every few years: repeats every N years from the start date and overrides
                the frequency above.
              </p>
              <Field label="End Date (optional -- leave blank to continue to the end of the plan)">
                <TextInput reg={register("endDate")} type="date" />
              </Field>
              <Field label="Annual Growth Rate (optional)">
                <TextInput reg={register("transferGrowthRatePct")} type="number" step="0.001" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Applies once this starts. Before the start date, the amount above is automatically inflated from
                today to the start date.
              </p>
            </>
          )}

          {selectedType === "growth_rate_change" && (
            <>
              <Field label="Account">
                <SelectInput reg={register("growthChangeAccountId", { required: true })} options={accountOptions} />
              </Field>
              <Field label="New Annual Growth Rate">
                <TextInput reg={register("growthChangeNewRatePct", { required: true })} type="number" step="0.001" />
              </Field>
              <p className="-mt-1 text-xs text-dim">
                Replaces this account's growth rate starting on the date above (e.g. shift to a more conservative
                rate at retirement). Add another one of these events later to change it again.
              </p>
            </>
          )}

          <div className="mt-2 flex items-center justify-between gap-2">
            {event ? (
              <button
                type="button"
                onClick={() => {
                  removeEvent(event.id);
                  onClose();
                }}
                className="rounded-md border border-negative/40 px-3 py-1.5 text-sm text-negative hover:bg-negative/10"
              >
                Delete
              </button>
            ) : (
              <button type="button" onClick={() => setSelectedType(null)} className="text-sm text-dim hover:text-foreground">
                ← Back
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
                Cancel
              </button>
              <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white">
                {event ? "Save" : "Add Event"}
              </button>
            </div>
          </div>
        </form>
      )}
    </Drawer>
  );
}
