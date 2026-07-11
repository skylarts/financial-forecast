"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, EventType, Person, RecurrenceFrequency, ScenarioEvent } from "@/domain";
import {
  retireEventSchema,
  buyHomeEventSchema,
  haveAKidEventSchema,
  customTransferEventSchema,
  growthRateChangeEventSchema,
} from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

// income_change / expense_change and windfall are not separate event types
// here -- a temporary raise/pause/cut lives directly on the income or
// expense it affects, and a one-time or recurring inflow/outflow is just an
// Income or Expense entry. Social Security is the same story: it's a plain
// Income entry with category "social_security" (that category is what
// triggers the once-per-year COLA compounding in the engine), entered via
// "+ Income" on the Timeline tab, not here.
const EVENT_TEMPLATES: { type: EventType; label: string; hint: string }[] = [
  { type: "retire", label: "Retire", hint: "Stop a person's salary income at a given date" },
  { type: "buy_home", label: "Buy a home", hint: "Creates a real estate asset, optionally financed" },
  { type: "have_a_kid", label: "Have a kid", hint: "Childcare costs + optional one-time cost" },
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
  isExcluded: boolean;
  personId: string;
  retirementAge: string;
  purchasePrice: string;
  downPaymentAmount: string;
  downPaymentFromAccountId: string;
  propertyGrowthRatePct: string;
  financed: boolean;
  mortgageRate: string;
  mortgageTermMonths: string;
  childcareMonthlyExpense: string;
  childcareEndDate: string;
  additionalOneTimeCost: string;
  kidPaymentAccountId: string;
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
  isExcluded: false,
  personId: "",
  retirementAge: "",
  purchasePrice: "",
  downPaymentAmount: "",
  downPaymentFromAccountId: "",
  propertyGrowthRatePct: "0.03",
  financed: true,
  mortgageRate: "0.06",
  mortgageTermMonths: "360",
  childcareMonthlyExpense: "",
  childcareEndDate: "",
  additionalOneTimeCost: "",
  kidPaymentAccountId: "",
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
  const base = {
    ...DEFAULTS,
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate ?? "",
    isExcluded: event.isExcluded ?? false,
  };
  switch (event.type) {
    case "retire":
      return { ...base, personId: event.personId, retirementAge: event.retirementAge?.toString() ?? "" };
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
    case "have_a_kid":
      return {
        ...base,
        childcareMonthlyExpense: event.childcareMonthlyExpense.toString(),
        childcareEndDate: event.childcareEndDate ?? "",
        additionalOneTimeCost: event.additionalOneTimeCost?.toString() ?? "",
        kidPaymentAccountId: event.paymentAccountId,
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
}: {
  open: boolean;
  onClose: () => void;
  event?: ScenarioEvent;
  accounts: Account[];
  people: Person[];
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

  const onSubmit = (v: FormValues) => {
    if (!selectedType) return;
    const base = {
      name: v.name.trim(),
      startDate: v.startDate,
      endDate: v.endDate || undefined,
      isExcluded: v.isExcluded,
    };
    let candidate: unknown;
    let schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

    switch (selectedType) {
      case "retire":
        candidate = { ...base, type: "retire", personId: v.personId, retirementAge: v.retirementAge ? Number(v.retirementAge) : undefined };
        schema = retireEventSchema.omit({ id: true });
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
                Replaces this account&rsquo;s growth rate starting on the date above (e.g. shift to a more conservative
                rate at retirement). Add another one of these events later to change it again.
              </p>
            </>
          )}

          <CheckboxInput reg={register("isExcluded")} label="Excluded (kept for reference, no effect on the projection)" />

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
