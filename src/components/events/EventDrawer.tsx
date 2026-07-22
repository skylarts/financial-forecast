"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, EventType, Person, RecurrenceFrequency, ScenarioEvent, TemporaryAdjustment } from "@/domain";
import {
  retireEventSchema,
  sellHomeEventSchema,
  haveAKidEventSchema,
  customTransferEventSchema,
} from "@/domain";
import { addMonths, elapsedYears } from "@/engine/dateMath";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor } from "@/components/ui/AdjustmentsEditor";
import { HomeDrawer } from "@/components/accounts/HomeDrawer";

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
  { type: "sell_home", label: "Sell a home", hint: "Sell a home you own -- retires its mortgage and credits net proceeds" },
  { type: "have_a_kid", label: "Have a kid", hint: "Childcare costs + optional one-time cost" },
  { type: "custom_transfer", label: "Custom transfer", hint: "Move money between two of your accounts" },
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
  hasRetirementExpense: boolean;
  retirementExpenseAmount: string;
  retirementExpenseGrowthRatePct: string;
  retirementExpensePaymentAccountId: string;
  retirementExpenseEndDate: string;
  sellRealEstateAccountId: string;
  sellNetProceeds: string;
  sellProceedsAccountId: string;
  childcareMonthlyExpense: string;
  childcareYears: string;
  additionalOneTimeCost: string;
  kidPaymentAccountId: string;
  transferAmount: string;
  fromAccountId: string;
  toAccountId: string;
  transferFrequency: RecurrenceFrequency;
  transferGrowthRatePct: string;
  transferIntervalYears: string;
}

const DEFAULTS: FormValues = {
  name: "",
  startDate: "",
  endDate: "",
  isExcluded: false,
  personId: "",
  retirementAge: "",
  hasRetirementExpense: false,
  retirementExpenseAmount: "",
  retirementExpenseGrowthRatePct: "0",
  retirementExpensePaymentAccountId: "",
  retirementExpenseEndDate: "",
  sellRealEstateAccountId: "",
  sellNetProceeds: "",
  sellProceedsAccountId: "",
  childcareMonthlyExpense: "",
  childcareYears: "",
  additionalOneTimeCost: "",
  kidPaymentAccountId: "",
  transferAmount: "",
  fromAccountId: "",
  toAccountId: "",
  transferFrequency: "monthly",
  transferGrowthRatePct: "",
  transferIntervalYears: "",
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
      return {
        ...base,
        personId: event.personId,
        retirementAge: event.retirementAge?.toString() ?? "",
        hasRetirementExpense: !!event.retirementExpense,
        retirementExpenseAmount: event.retirementExpense?.amount.toString() ?? "",
        retirementExpenseGrowthRatePct: event.retirementExpense?.growthRatePct.toString() ?? "0",
        retirementExpensePaymentAccountId: event.retirementExpense?.paymentAccountId ?? "",
        retirementExpenseEndDate: event.retirementExpense?.endDate ?? "",
      };
    case "buy_home":
      // Handled entirely by HomeDrawer (see the early return in the component
      // below) -- never actually reaches this form.
      return base;
    case "sell_home":
      return {
        ...base,
        sellRealEstateAccountId: event.realEstateAccountId,
        sellNetProceeds: event.netProceeds.toString(),
        sellProceedsAccountId: event.proceedsAccountId ?? "",
      };
    case "sell_home":
      return {
        ...base,
        sellRealEstateAccountId: event.realEstateAccountId,
        sellNetProceeds: event.netProceeds.toString(),
        sellProceedsAccountId: event.proceedsAccountId ?? "",
      };
    case "have_a_kid":
      return {
        ...base,
        childcareMonthlyExpense: event.childcareMonthlyExpense.toString(),
        childcareYears: event.childcareEndDate
          ? Math.round(elapsedYears(event.startDate, event.childcareEndDate)).toString()
          : "",
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
  const [retirementExpenseAdjustments, setRetirementExpenseAdjustments] = useState<TemporaryAdjustment[]>(
    event?.type === "retire" ? event.retirementExpense?.adjustments ?? [] : []
  );
  const { register, handleSubmit, watch, reset } = useForm<FormValues>({
    defaultValues: event ? eventToFormValues(event) : DEFAULTS,
  });

  useEffect(() => {
    setSelectedType(event?.type ?? null);
    reset(event ? eventToFormValues(event) : DEFAULTS);
    setRetirementExpenseAdjustments(event?.type === "retire" ? event.retirementExpense?.adjustments ?? [] : []);
    setError(null);
  }, [event, open, reset]);

  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));
  const personOptions = people.map((p) => ({ value: p.id, label: p.name }));
  // Any real_estate account works here now -- whether entered directly (the
  // Accounts tab / "add a home you already own") or created by an earlier
  // buy_home event, both are real Accounts. See resolveEvents.ts.
  const realEstateOptions = accounts.filter((a) => a.class === "real_estate").map((a) => ({ value: a.id, label: a.name }));
  const hasRetirementExpense = watch("hasRetirementExpense");

  // buy_home is handled entirely by HomeDrawer (see the early return below),
  // so it never reaches this form.
  if (selectedType === "buy_home") {
    const buyEvent = event?.type === "buy_home" ? event : undefined;
    const linkedAccount = buyEvent ? accounts.find((a) => a.id === buyEvent.realEstateAccountId) : undefined;
    return (
      <HomeDrawer open={open} onClose={onClose} account={linkedAccount} event={buyEvent} accounts={accounts} initialMode="buy" />
    );
  }

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
        candidate = {
          ...base,
          type: "retire",
          personId: v.personId,
          retirementAge: v.retirementAge ? Number(v.retirementAge) : undefined,
          retirementExpense: v.hasRetirementExpense
            ? {
                amount: Number(v.retirementExpenseAmount),
                growthRatePct: Number(v.retirementExpenseGrowthRatePct) || 0,
                paymentAccountId: v.retirementExpensePaymentAccountId || null,
                endDate: v.retirementExpenseEndDate || null,
                adjustments: retirementExpenseAdjustments,
              }
            : null,
        };
        schema = retireEventSchema.omit({ id: true });
        break;
      case "sell_home":
        candidate = {
          ...base,
          type: "sell_home",
          realEstateAccountId: v.sellRealEstateAccountId,
          netProceeds: Number(v.sellNetProceeds),
          proceedsAccountId: v.sellProceedsAccountId || null,
        };
        schema = sellHomeEventSchema.omit({ id: true });
        break;
      case "sell_home":
        candidate = {
          ...base,
          type: "sell_home",
          realEstateAccountId: v.sellRealEstateAccountId,
          netProceeds: Number(v.sellNetProceeds),
          proceedsAccountId: v.sellProceedsAccountId || null,
        };
        schema = sellHomeEventSchema.omit({ id: true });
        break;
      case "have_a_kid":
        candidate = {
          ...base,
          type: "have_a_kid",
          childcareMonthlyExpense: Number(v.childcareMonthlyExpense),
          childcareEndDate: v.childcareYears.trim() !== "" ? addMonths(v.startDate, Number(v.childcareYears) * 12) : null,
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
              <Field label="Retirement Age" hint="Optional -- overrides the person's default retirement age from Assumptions for this event only.">
                <TextInput reg={register("retirementAge")} type="number" />
              </Field>
              <CheckboxInput
                reg={register("hasRetirementExpense")}
                label="Add a retirement expense (e.g. more travel, hobbies)"
              />
              {hasRetirementExpense && (
                <div className="flex flex-col gap-3 border-l border-border pl-3">
                  <Field label="Yearly Amount" hint="Today's dollars -- starts the day retirement begins.">
                    <TextInput reg={register("retirementExpenseAmount", { required: true })} type="number" step="0.01" />
                  </Field>
                  <Field label="Annual Growth Rate" hint="Actual rate, not just inflation. 0 = flat in nominal terms.">
                    <TextInput reg={register("retirementExpenseGrowthRatePct")} type="number" step="0.001" />
                  </Field>
                  <Field label="Payment Account">
                    <SelectInput
                      reg={register("retirementExpensePaymentAccountId")}
                      options={[{ value: "", label: "Extra Savings (Default)" }, ...accountOptions]}
                    />
                  </Field>
                  <Field label="End Date (optional)" hint="Leave blank to continue through the end of the plan.">
                    <TextInput reg={register("retirementExpenseEndDate")} type="date" />
                  </Field>
                  <AdjustmentsEditor
                    adjustments={retirementExpenseAdjustments}
                    onChange={setRetirementExpenseAdjustments}
                    helpText="A temporary boost or cut to this expense (e.g. a few extra years of travel budget)."
                  />
                </div>
              )}
            </>
          )}

          {selectedType === "sell_home" && (
            <>
              {realEstateOptions.length === 0 ? (
                <p className="text-sm text-dim">
                  No homes to sell yet -- add one first via &ldquo;Add a Home You Already Own&rdquo; on the Accounts tab.
                </p>
              ) : (
                <Field label="Which Home">
                  <SelectInput reg={register("sellRealEstateAccountId", { required: true })} options={realEstateOptions} />
                </Field>
              )}
              <Field
                label="Net Proceeds from Sale"
                hint="What actually lands in your account: sale price, minus your agent's commission and closing costs, minus whatever's left on the mortgage. E.g. a $500k sale, 6% selling costs ($30k), and a $250k mortgage payoff nets $220k. Can be negative if you'd owe more than the home is worth. Today's dollars -- inflated forward to the sale date; this home's mortgage (if any) is fully retired the same day."
              >
                <TextInput reg={register("sellNetProceeds", { required: true })} type="number" step="0.01" />
              </Field>
              <Field label="Proceeds Go To">
                <SelectInput
                  reg={register("sellProceedsAccountId")}
                  options={[{ value: "", label: "Extra Savings (Default)" }, ...accountOptions]}
                />
              </Field>
            </>
          )}

          {selectedType === "sell_home" && (
            <>
              {realEstateOptions.length === 0 ? (
                <p className="text-sm text-dim">
                  No homes to sell yet -- add one first via &ldquo;Add a Home You Already Own&rdquo; on the Accounts tab.
                </p>
              ) : (
                <Field label="Which Home">
                  <SelectInput reg={register("sellRealEstateAccountId", { required: true })} options={realEstateOptions} />
                </Field>
              )}
              <Field
                label="Net Proceeds from Sale"
                hint="What actually lands in your account: sale price, minus your agent's commission and closing costs, minus whatever's left on the mortgage. E.g. a $500k sale, 6% selling costs ($30k), and a $250k mortgage payoff nets $220k. Can be negative if you'd owe more than the home is worth. Today's dollars -- inflated forward to the sale date; this home's mortgage (if any) is fully retired the same day."
              >
                <TextInput reg={register("sellNetProceeds", { required: true })} type="number" step="0.01" />
              </Field>
              <Field label="Proceeds Go To">
                <SelectInput
                  reg={register("sellProceedsAccountId")}
                  options={[{ value: "", label: "Extra Savings (Default)" }, ...accountOptions]}
                />
              </Field>
            </>
          )}

          {selectedType === "have_a_kid" && (
            <>
              <Field label="Monthly Childcare Expense" hint="Today's dollars -- inflates with the plan's inflation rate as each month's cost comes due.">
                <TextInput reg={register("childcareMonthlyExpense", { required: true })} type="number" step="0.01" />
              </Field>
              <Field
                label="Years of Child Expenses (optional)"
                hint="An existing child? Enter remaining years of expenses. Leave blank to run through the end of the plan."
              >
                <TextInput reg={register("childcareYears")} type="number" min="0" step="1" placeholder="e.g. 18" />
              </Field>
              <Field label="Upfront Child Costs (optional)" hint="One-time costs for birth, adoption, or setup -- today's dollars, inflated forward to when it occurs.">
                <TextInput reg={register("additionalOneTimeCost")} type="number" step="0.01" />
              </Field>
              <Field label="Payment Account">
                <SelectInput reg={register("kidPaymentAccountId", { required: true })} options={accountOptions} />
              </Field>
            </>
          )}

          {selectedType === "custom_transfer" && (
            <>
              <Field label="Amount" hint="Per occurrence, today's dollars -- inflated forward from today to the start date.">
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
              <Field
                label="Or repeat every N years (optional)"
                hint="For a repeat purchase like a car every few years. Overrides the Frequency above."
              >
                <TextInput reg={register("transferIntervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
              </Field>
              <Field label="End Date (optional)" hint="Leave blank to continue to the end of the plan.">
                <TextInput reg={register("endDate")} type="date" />
              </Field>
              <Field label="Annual Growth Rate (optional)" hint="Applies once the transfer starts.">
                <TextInput reg={register("transferGrowthRatePct")} type="number" step="0.001" />
              </Field>
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
