"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, EventType, Person, RecurrenceFrequency, ScenarioEvent, TemporaryAdjustment } from "@/domain";
import {
  retireEventSchema,
  buyHomeEventSchema,
  haveAKidEventSchema,
  customTransferEventSchema,
} from "@/domain";
import { addMonths, elapsedYears } from "@/engine/dateMath";
import { computeMonthlyPayment } from "@/engine/amortization";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextInput, SelectInput, CheckboxInput, ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor } from "@/components/ui/AdjustmentsEditor";

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
  purchasePrice: string;
  downPaymentAmount: string;
  downPaymentFromAccountId: string;
  propertyGrowthRatePct: string;
  financed: boolean;
  mortgageRate: string;
  mortgageTermYears: string;
  mortgageExtraPrincipal: string;
  propertyTaxRatePct: string;
  homeInsuranceRatePct: string;
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
  purchasePrice: "",
  downPaymentAmount: "",
  downPaymentFromAccountId: "",
  propertyGrowthRatePct: "0.03",
  financed: true,
  mortgageRate: "0.06",
  mortgageTermYears: "30",
  mortgageExtraPrincipal: "",
  propertyTaxRatePct: "0.01",
  homeInsuranceRatePct: "0.005",
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
      return {
        ...base,
        purchasePrice: event.purchasePrice.toString(),
        downPaymentAmount: event.downPaymentAmount.toString(),
        downPaymentFromAccountId: event.downPaymentFromAccountId,
        propertyGrowthRatePct: event.propertyGrowthRatePct.toString(),
        financed: event.mortgage !== null,
        mortgageRate: event.mortgage?.annualInterestRatePct.toString() ?? "0.06",
        mortgageTermYears: event.mortgage ? Math.round(event.mortgage.termMonths / 12).toString() : "30",
        mortgageExtraPrincipal: event.mortgage?.extraPrincipalMonthly?.toString() ?? "",
        propertyTaxRatePct: event.propertyTaxRatePct?.toString() ?? "",
        homeInsuranceRatePct: event.homeInsuranceRatePct?.toString() ?? "",
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
  const { register, handleSubmit, watch, reset, setValue } = useForm<FormValues>({
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
  const financed = watch("financed");
  const hasRetirementExpense = watch("hasRetirementExpense");

  // Live monthly-payment breakdown for the Buy-a-home form. Recomputed from the
  // current field values so the user sees P&I, tax, and insurance update as they
  // type -- purely a display aid; the engine recomputes independently on save.
  const homePrice = Number(watch("purchasePrice")) || 0;
  const homeDown = financed ? Number(watch("downPaymentAmount")) || 0 : homePrice;
  const homePrincipal = Math.max(0, homePrice - homeDown);
  const homeRate = Number(watch("mortgageRate")) || 0;
  const homeTermMonths = (Number(watch("mortgageTermYears")) || 0) * 12;
  const homeExtra = financed ? Number(watch("mortgageExtraPrincipal")) || 0 : 0;
  const homePI = financed && homePrincipal > 0 && homeTermMonths > 0
    ? computeMonthlyPayment(homePrincipal, homeRate, homeTermMonths)
    : 0;
  const homeTaxMonthly = (homePrice * (Number(watch("propertyTaxRatePct")) || 0)) / 12;
  const homeInsuranceMonthly = (homePrice * (Number(watch("homeInsuranceRatePct")) || 0)) / 12;
  const homeMonthlyTotal = homePI + homeExtra + homeTaxMonthly + homeInsuranceMonthly;
  const money0 = (n: number) => `$${Math.round(n).toLocaleString()}`;

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
      case "buy_home":
        candidate = {
          ...base,
          type: "buy_home",
          purchasePrice: Number(v.purchasePrice),
          // Cash mode has no separate down payment -- store the full price so the
          // single upfront posting funds the whole home (the engine treats the
          // down payment as the money that leaves your account up front).
          downPaymentAmount: v.financed ? Number(v.downPaymentAmount) : Number(v.purchasePrice),
          downPaymentFromAccountId: v.downPaymentFromAccountId,
          propertyGrowthRatePct: Number(v.propertyGrowthRatePct),
          mortgage: v.financed
            ? {
                annualInterestRatePct: Number(v.mortgageRate),
                termMonths: Number(v.mortgageTermYears) * 12,
                extraPrincipalMonthly:
                  v.mortgageExtraPrincipal.trim() !== "" ? Number(v.mortgageExtraPrincipal) : undefined,
              }
            : null,
          propertyTaxRatePct: v.propertyTaxRatePct.trim() !== "" ? Number(v.propertyTaxRatePct) : undefined,
          homeInsuranceRatePct: v.homeInsuranceRatePct.trim() !== "" ? Number(v.homeInsuranceRatePct) : undefined,
        };
        schema = buyHomeEventSchema.omit({ id: true });
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

          {selectedType === "buy_home" && (
            <>
              <Field label="Purchase Price" hint="Today's dollars -- inflated forward to the purchase date.">
                <TextInput reg={register("purchasePrice", { required: true })} type="number" step="0.01" />
              </Field>

              {/* Finance / Pay cash segmented toggle. Cash mode funds the whole
                  price from one account, so the down-payment inputs disappear. */}
              <div className="flex rounded-md border border-border p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setValue("financed", true)}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${
                    financed ? "bg-accent text-white" : "text-dim hover:text-foreground"
                  }`}
                >
                  Finance
                </button>
                <button
                  type="button"
                  onClick={() => setValue("financed", false)}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${
                    !financed ? "bg-accent text-white" : "text-dim hover:text-foreground"
                  }`}
                >
                  Pay cash
                </button>
              </div>

              {financed && (
                <>
                  <Field label="Down Payment" hint="Today's dollars -- inflated the same as the purchase price, so it stays the same share.">
                    <TextInput reg={register("downPaymentAmount", { required: true })} type="number" step="0.01" />
                  </Field>
                  <Field label="Mortgage Rate">
                    <TextInput reg={register("mortgageRate")} type="number" step="0.001" />
                  </Field>
                  <Field label="Term (years)">
                    <TextInput reg={register("mortgageTermYears")} type="number" step="1" />
                  </Field>
                  <Field
                    label="Extra Principal / month (optional)"
                    hint="Paid on top of the scheduled payment -- pays the loan off early."
                  >
                    <TextInput reg={register("mortgageExtraPrincipal")} type="number" step="0.01" placeholder="e.g. 200" />
                  </Field>
                </>
              )}

              <Field label={financed ? "Pay Down Payment From" : "Pay From"}>
                <SelectInput reg={register("downPaymentFromAccountId", { required: true })} options={accountOptions} />
              </Field>
              <Field label="Annual Property Growth Rate">
                <TextInput reg={register("propertyGrowthRatePct")} type="number" step="0.001" />
              </Field>
              <Field label="Property Tax Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.01 = 1%. Grows with the home.">
                <TextInput reg={register("propertyTaxRatePct")} type="number" step="0.001" placeholder="e.g. 0.01" />
              </Field>
              <Field label="Home Insurance Rate (per year, optional)" hint="Share of the home's value per year, e.g. 0.005 = 0.5%. Grows with the home.">
                <TextInput reg={register("homeInsuranceRatePct")} type="number" step="0.001" placeholder="e.g. 0.005" />
              </Field>

              {homePrice > 0 && (
                <div className="rounded-md border border-border p-3 text-sm">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-dim">Est. monthly cost</span>
                    <span className="text-base font-semibold">{money0(homeMonthlyTotal)}</span>
                  </div>
                  <div className="flex flex-col gap-1 text-xs text-dim">
                    {financed && (
                      <div className="flex justify-between">
                        <span>Principal &amp; interest</span>
                        <span>{money0(homePI)}</span>
                      </div>
                    )}
                    {homeExtra > 0 && (
                      <div className="flex justify-between">
                        <span>Extra principal</span>
                        <span>{money0(homeExtra)}</span>
                      </div>
                    )}
                    {homeTaxMonthly > 0 && (
                      <div className="flex justify-between">
                        <span>Property tax</span>
                        <span>{money0(homeTaxMonthly)}</span>
                      </div>
                    )}
                    {homeInsuranceMonthly > 0 && (
                      <div className="flex justify-between">
                        <span>Home insurance</span>
                        <span>{money0(homeInsuranceMonthly)}</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-dim">Today's dollars. Tax &amp; insurance grow with the home's value.</p>
                </div>
              )}
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
