"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, EventType, Person, RecurrenceFrequency, ScenarioEvent, TemporaryAdjustment } from "@/domain";
import {
  retireEventSchema,
  sellHomeEventSchema,
  rothConversionEventSchema,
  payOffLoanEventSchema,
  rolloverEventSchema,
  customTransferEventSchema,
} from "@/domain";
import { birthdayAtAge } from "@/engine/dateMath";
import { Drawer } from "@/components/ui/Drawer";
import {
  DrawerFooter,
  ErrorBanner,
  Field,
  FieldRow,
  FREQUENCY_OPTIONS,
  MoneyInput,
  PercentInput,
  SelectInput,
  CheckboxInput,
  TextInput,
  implausibleRateMessage,
} from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor, adjustmentsIssue } from "@/components/ui/AdjustmentsEditor";
import { HomeDrawer } from "@/components/accounts/HomeDrawer";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { treatmentOf } from "@/engine/resolveEvents";

// A temporary raise/pause/cut lives directly on the income or expense it
// affects, and Social Security is a plain Income entry -- so Income and
// Expense are offered here as templates that hand off to their own drawers,
// same as Buy a home hands off to HomeDrawer. Childcare is an ordinary
// expense too (a monthly cost with an end date), so there is no separate
// "have a kid" template any more.
type TemplateType = EventType | "income" | "expense";

const EVENT_TEMPLATES: { type: TemplateType; label: string; hint: string }[] = [
  { type: "income", label: "Income", hint: "Salary, Social Security, pension, rental, or a one-time payment" },
  { type: "expense", label: "Expense", hint: "A recurring or one-time cost, including childcare or a car every few years" },
  { type: "retire", label: "Retire", hint: "Stop a person's salary and paycheck contributions on a date" },
  { type: "buy_home", label: "Buy a home", hint: "Creates a real estate asset, optionally financed" },
  { type: "sell_home", label: "Sell a home", hint: "Sell a home you own: retires its mortgage and credits the proceeds" },
  { type: "roth_conversion", label: "Roth conversion", hint: "Move money from a tax-deferred account to a Roth: taxed as income, never penalized" },
  { type: "pay_off_loan", label: "Pay off a loan", hint: "Pay a mortgage or loan down, or off, from an account on a date" },
  { type: "rollover", label: "Rollover", hint: "Move money between two tax-deferred accounts, with no tax" },
  { type: "custom_transfer", label: "Custom transfer", hint: "Any other move between two of your accounts" },
];

const BRACKET_OPTIONS = [
  { value: "0.1", label: "10% bracket" },
  { value: "0.12", label: "12% bracket" },
  { value: "0.22", label: "22% bracket" },
  { value: "0.24", label: "24% bracket" },
];

interface FormValues {
  name: string;
  startDate: string;
  endDate: string;
  isExcluded: boolean;
  notes: string;
  personId: string;
  retirementAge: string;
  hasRetirementExpense: boolean;
  /** Money string. */
  retirementExpenseAmount: string;
  /** Percent string; blank = matches inflation. */
  retirementExpenseGrowthRatePct: string;
  retirementExpensePaymentAccountId: string;
  retirementExpenseEndDate: string;
  sellRealEstateAccountId: string;
  /** "computed" (engine derives from simulated equity) or "fixed" (enter net proceeds directly). */
  sellMode: string;
  /** Percent string, e.g. "6" for 6% selling costs. Computed mode only. */
  sellingCostsPct: string;
  /** Money string. Fixed mode only. */
  sellNetProceeds: string;
  sellProceedsAccountId: string;
  /** Money string. */
  transferAmount: string;
  fromAccountId: string;
  toAccountId: string;
  transferFrequency: RecurrenceFrequency;
  /** Percent string; blank = matches inflation. */
  transferGrowthRatePct: string;
  transferIntervalYears: string;
  /** Roth conversion: "amount" or "bracket". */
  conversionMode: string;
  conversionBracket: string;
  conversionFrequency: "annual" | "one_time";
  conversionTaxSource: "cash" | "withhold";
  /** Pay off / rollover: take the whole balance (or whatever is left on the loan). */
  wholeBalance: boolean;
  loanAccountId: string;
}

const DEFAULTS: FormValues = {
  name: "",
  startDate: "",
  endDate: "",
  isExcluded: false,
  notes: "",
  personId: "",
  retirementAge: "",
  hasRetirementExpense: false,
  retirementExpenseAmount: "",
  retirementExpenseGrowthRatePct: "",
  retirementExpensePaymentAccountId: "",
  retirementExpenseEndDate: "",
  sellRealEstateAccountId: "",
  sellMode: "computed",
  sellingCostsPct: "6",
  sellNetProceeds: "",
  sellProceedsAccountId: "",
  transferAmount: "",
  fromAccountId: "",
  toAccountId: "",
  transferFrequency: "monthly",
  transferGrowthRatePct: "",
  transferIntervalYears: "",
  conversionMode: "amount",
  conversionBracket: "0.12",
  conversionFrequency: "annual",
  conversionTaxSource: "cash",
  wholeBalance: true,
  loanAccountId: "",
};

function eventToFormValues(event: ScenarioEvent): FormValues {
  const base: FormValues = {
    ...DEFAULTS,
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate ?? "",
    isExcluded: event.isExcluded ?? false,
    notes: event.notes ?? "",
  };
  switch (event.type) {
    case "retire":
      return {
        ...base,
        personId: event.personId,
        retirementAge: event.retirementAge?.toString() ?? "",
        hasRetirementExpense: !!event.retirementExpense,
        retirementExpenseAmount: event.retirementExpense ? moneyToStr(event.retirementExpense.amount) : "",
        retirementExpenseGrowthRatePct: fractionToPercentStr(event.retirementExpense?.growthRatePct),
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
        sellMode: event.sellingCostsPct != null ? "computed" : "fixed",
        sellingCostsPct: event.sellingCostsPct != null ? fractionToPercentStr(event.sellingCostsPct) : "6",
        sellNetProceeds: moneyToStr(event.netProceeds),
        sellProceedsAccountId: event.proceedsAccountId ?? "",
      };
    case "roth_conversion":
      return {
        ...base,
        fromAccountId: event.fromAccountId,
        toAccountId: event.toAccountId,
        transferAmount: event.amount != null ? moneyToStr(event.amount) : "",
        conversionMode: event.fillToBracketRate != null ? "bracket" : "amount",
        conversionBracket: event.fillToBracketRate != null ? String(event.fillToBracketRate) : "0.12",
        conversionFrequency: event.frequency,
        conversionTaxSource: event.taxSource,
        transferGrowthRatePct: fractionToPercentStr(event.growthRatePct),
      };
    case "pay_off_loan":
      return {
        ...base,
        loanAccountId: event.loanAccountId,
        fromAccountId: event.fromAccountId,
        wholeBalance: event.amount == null,
        transferAmount: event.amount != null ? moneyToStr(event.amount) : "",
      };
    case "rollover":
      return {
        ...base,
        fromAccountId: event.fromAccountId,
        toAccountId: event.toAccountId,
        wholeBalance: event.amount == null,
        transferAmount: event.amount != null ? moneyToStr(event.amount) : "",
      };
    case "custom_transfer":
      return {
        ...base,
        transferAmount: moneyToStr(event.amount),
        fromAccountId: event.fromAccountId,
        toAccountId: event.toAccountId,
        transferFrequency: event.frequency,
        transferGrowthRatePct: fractionToPercentStr(event.growthRatePct),
        transferIntervalYears: event.intervalYears?.toString() ?? "",
      };
  }
}

/** An option label that says who owns the account when two share a name. */
function accountOptionLabel(a: Account, people: Person[]): string {
  if (!a.ownerId) return a.name;
  const owner = people.find((p) => p.id === a.ownerId)?.name;
  return owner ? `${a.name} (${owner})` : a.name;
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
  const inflationRatePct = usePlanStore((s) => s.activeScenario().settings.inflationRatePct);
  const inflationPctLabel = fractionToPercentStr(inflationRatePct) || "0";

  const [selectedType, setSelectedType] = useState<TemplateType | null>(event?.type ?? null);
  const [error, setError] = useState<string | null>(null);
  const [retirementExpenseAdjustments, setRetirementExpenseAdjustments] = useState<TemporaryAdjustment[]>(
    event?.type === "retire" ? event.retirementExpense?.adjustments ?? [] : []
  );
  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    getValues,
    formState: { isDirty },
  } = useForm<FormValues>({
    defaultValues: event ? eventToFormValues(event) : DEFAULTS,
  });
  const [adjustmentsKey, setAdjustmentsKey] = useState(() =>
    JSON.stringify(event?.type === "retire" ? event.retirementExpense?.adjustments ?? [] : [])
  );
  const dirty = isDirty || JSON.stringify(retirementExpenseAdjustments) !== adjustmentsKey;

  useEffect(() => {
    setSelectedType(event?.type ?? null);
    reset(event ? eventToFormValues(event) : DEFAULTS);
    const adj = event?.type === "retire" ? event.retirementExpense?.adjustments ?? [] : [];
    setRetirementExpenseAdjustments(adj);
    setAdjustmentsKey(JSON.stringify(adj));
    setError(null);
  }, [event, open, reset]);

  const opt = (list: Account[]) => list.map((a) => ({ value: a.id, label: accountOptionLabel(a, people) }));
  const accountOptions = opt(accounts);
  const assetOptions = opt(accounts.filter((a) => a.category === "asset" && a.class !== "real_estate"));
  const deferredOptions = opt(accounts.filter((a) => treatmentOf(a) === "tax_deferred"));
  const rothOptions = opt(accounts.filter((a) => treatmentOf(a) === "tax_free" && a.class !== "education_529" && a.class !== "hsa"));
  const loanOptions = opt(accounts.filter((a) => a.category === "liability"));
  const personOptions = people.map((p) => ({ value: p.id, label: p.name }));
  const realEstateOptions = opt(accounts.filter((a) => a.class === "real_estate"));
  const hasRetirementExpense = watch("hasRetirementExpense");
  const sellMode = watch("sellMode");
  const retirePersonId = watch("personId");
  const conversionMode = watch("conversionMode");
  const conversionFrequency = watch("conversionFrequency");
  const wholeBalance = watch("wholeBalance");

  // buy_home, income, and expense are each handled entirely by their own
  // drawer (see the early returns below), so none of them ever reach the
  // generic form further down.
  if (selectedType === "buy_home") {
    const buyEvent = event?.type === "buy_home" ? event : undefined;
    const linkedAccount = buyEvent ? accounts.find((a) => a.id === buyEvent.realEstateAccountId) : undefined;
    return (
      <HomeDrawer open={open} onClose={onClose} account={linkedAccount} event={buyEvent} accounts={accounts} initialMode="buy" />
    );
  }
  if (selectedType === "income") {
    return <IncomeDrawer open={open} onClose={onClose} income={undefined} people={people} accounts={accounts} />;
  }
  if (selectedType === "expense") {
    return <ExpenseDrawer open={open} onClose={onClose} expense={undefined} accounts={accounts} />;
  }

  /**
   * Picking a template preselects the pickers that have exactly one sensible
   * default -- the first tax-deferred account to convert from, the first
   * Roth to convert into, and so on -- so a fresh form is submittable as-is
   * instead of failing a silent "required" check on a blank select.
   */
  const chooseTemplate = (type: TemplateType) => {
    setSelectedType(type);
    setError(null);
    const first = (list: { value: string }[]) => list[0]?.value ?? "";
    const second = (list: { value: string }[]) => list[1]?.value ?? first(list);
    switch (type) {
      case "retire":
        setValue("personId", first(personOptions));
        break;
      case "sell_home":
        setValue("sellRealEstateAccountId", first(realEstateOptions));
        break;
      case "roth_conversion":
        setValue("fromAccountId", first(deferredOptions));
        setValue("toAccountId", first(rothOptions));
        break;
      case "pay_off_loan":
        setValue("loanAccountId", first(loanOptions));
        setValue("fromAccountId", first(assetOptions));
        break;
      case "rollover":
        setValue("fromAccountId", first(deferredOptions));
        setValue("toAccountId", second(deferredOptions));
        break;
      case "custom_transfer":
        setValue("fromAccountId", first(assetOptions));
        setValue("toAccountId", second(assetOptions));
        break;
      default:
        break;
    }
  };

  /** A required field left blank: say so instead of ignoring the click. */
  const onInvalid = (errors: Record<string, unknown>) => {
    const field = Object.keys(errors)[0];
    const labels: Record<string, string> = {
      name: "a name",
      startDate: "a date",
      fromAccountId: "the account to take the money from",
      toAccountId: "the account the money goes to",
      loanAccountId: "which loan to pay",
      sellRealEstateAccountId: "which home to sell",
      transferAmount: "an amount",
    };
    setError(`This event still needs ${labels[field ?? ""] ?? "a required field"}.`);
  };

  /** Typing a retirement age fills the start date with that person's birthday at that age. */
  const syncRetireDateFromAge = (ageStr: string, personIdNow: string = retirePersonId) => {
    const age = Number(ageStr);
    const person = people.find((p) => p.id === (personIdNow || people[0]?.id));
    if (person && Number.isFinite(age) && age > 0) {
      setValue("startDate", birthdayAtAge(person.birthDate, age), { shouldDirty: true });
    }
  };

  const onSubmit = (v: FormValues) => {
    if (!selectedType) return;
    const base = {
      name: v.name.trim(),
      startDate: v.startDate,
      isExcluded: v.isExcluded,
      notes: v.notes.trim() || undefined,
    };
    let candidate: unknown;
    let schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

    const growthIssue =
      implausibleRateMessage("The growth rate", percentStrToFraction(v.transferGrowthRatePct)) ??
      implausibleRateMessage("The expense growth rate", percentStrToFraction(v.retirementExpenseGrowthRatePct));
    if (growthIssue) {
      setError(growthIssue);
      return;
    }
    if (selectedType === "retire" && v.hasRetirementExpense) {
      const adjIssue = adjustmentsIssue(retirementExpenseAdjustments);
      if (adjIssue) {
        setError(adjIssue);
        return;
      }
    }
    switch (selectedType) {
      case "retire":
        candidate = {
          ...base,
          type: "retire",
          personId: v.personId,
          retirementAge: v.retirementAge ? Number(v.retirementAge) : undefined,
          retirementExpense: v.hasRetirementExpense
            ? {
                amount: moneyStrToNumber(v.retirementExpenseAmount) ?? 0,
                growthRatePct: percentStrToFraction(v.retirementExpenseGrowthRatePct),
                paymentAccountId: v.retirementExpensePaymentAccountId || null,
                endDate: v.retirementExpenseEndDate || null,
                adjustments: retirementExpenseAdjustments,
              }
            : null,
        };
        schema = retireEventSchema.omit({ id: true });
        break;
      case "sell_home": {
        const computed = v.sellMode === "computed";
        candidate = {
          ...base,
          type: "sell_home",
          realEstateAccountId: v.sellRealEstateAccountId,
          netProceeds: computed ? 0 : moneyStrToNumber(v.sellNetProceeds) ?? 0,
          sellingCostsPct: computed ? percentStrToFraction(v.sellingCostsPct) ?? 0.06 : null,
          proceedsAccountId: v.sellProceedsAccountId || null,
        };
        schema = sellHomeEventSchema.omit({ id: true });
        break;
      }
      case "roth_conversion":
        candidate = {
          ...base,
          endDate: v.conversionFrequency === "one_time" ? null : v.endDate || null,
          type: "roth_conversion",
          fromAccountId: v.fromAccountId,
          toAccountId: v.toAccountId,
          amount: v.conversionMode === "bracket" ? null : moneyStrToNumber(v.transferAmount),
          fillToBracketRate: v.conversionMode === "bracket" ? Number(v.conversionBracket) : null,
          frequency: v.conversionFrequency,
          taxSource: v.conversionTaxSource,
          growthRatePct: percentStrToFraction(v.transferGrowthRatePct),
        };
        schema = rothConversionEventSchema.omit({ id: true });
        break;
      case "pay_off_loan":
        candidate = {
          ...base,
          type: "pay_off_loan",
          loanAccountId: v.loanAccountId,
          fromAccountId: v.fromAccountId,
          amount: v.wholeBalance ? null : moneyStrToNumber(v.transferAmount),
        };
        schema = payOffLoanEventSchema.omit({ id: true });
        break;
      case "rollover":
        candidate = {
          ...base,
          type: "rollover",
          fromAccountId: v.fromAccountId,
          toAccountId: v.toAccountId,
          amount: v.wholeBalance ? null : moneyStrToNumber(v.transferAmount),
        };
        schema = rolloverEventSchema.omit({ id: true });
        break;
      case "custom_transfer":
        candidate = {
          ...base,
          endDate: v.endDate || undefined,
          type: "custom_transfer",
          amount: moneyStrToNumber(v.transferAmount) ?? 0,
          fromAccountId: v.fromAccountId,
          toAccountId: v.toAccountId,
          frequency: v.transferFrequency,
          growthRatePct: percentStrToFraction(v.transferGrowthRatePct),
          intervalYears: v.transferIntervalYears.trim() !== "" ? Number(v.transferIntervalYears) : undefined,
        };
        schema = customTransferEventSchema.omit({ id: true });
        break;
      default:
        return;
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

  const isWholeBalanceKind = selectedType === "pay_off_loan" || selectedType === "rollover";

  return (
    <Drawer open={open} onClose={onClose} title={event ? "Edit Event" : "Add Event"} dirty={selectedType !== null && dirty}>
      {!selectedType ? (
        <div className="flex flex-col gap-2">
          {EVENT_TEMPLATES.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => chooseTemplate(t.type)}
              className="rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent"
            >
              <div className="text-sm font-medium">{t.label}</div>
              <div className="text-xs text-dim">{t.hint}</div>
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="flex flex-col gap-3">
          <ErrorBanner message={error} />
          <Field label="Name">
            <TextInput reg={register("name", { required: true })} />
          </Field>

          {selectedType === "retire" && (
            <>
              <Field label="Person">
                <SelectInput
                  reg={register("personId", {
                    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                      // The age is this person's: re-derive the date for them.
                      const age = getValues("retirementAge");
                      if (age.trim() !== "") syncRetireDateFromAge(age, e.target.value);
                    },
                  })}
                  options={personOptions}
                />
              </Field>
              <Field label="Retirement Age" hint="Typing an age fills the start date below with that person's birthday at that age -- adjust the exact date freely afterward.">
                <TextInput
                  reg={register("retirementAge", {
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => syncRetireDateFromAge(e.target.value),
                  })}
                  type="number"
                />
              </Field>
            </>
          )}

          <Field label={selectedType === "roth_conversion" && conversionFrequency === "annual" ? "First Year (date)" : "Date"}>
            <TextInput reg={register("startDate", { required: true })} type="date" />
          </Field>

          {selectedType === "retire" && (
            <>
              <CheckboxInput
                reg={register("hasRetirementExpense")}
                label="Add a retirement expense (e.g. more travel, hobbies)"
              />
              {hasRetirementExpense && (
                <div className="flex flex-col gap-3 border-l border-border pl-3">
                  <Field label="Yearly Amount" hint="Today's dollars, spread through each year -- starts the day retirement begins.">
                    <MoneyInput reg={register("retirementExpenseAmount", { required: true })} placeholder="e.g. 12,000" />
                  </Field>
                  <Field
                    label="Annual Growth Rate"
                    hint={`Percent per year. Blank = matches inflation (${inflationPctLabel}%), keeping it flat in today's dollars. 0 = flat nominal (shrinks in real terms).`}
                  >
                    <PercentInput reg={register("retirementExpenseGrowthRatePct")} placeholder={`blank = inflation (${inflationPctLabel}%)`} />
                  </Field>
                  <Field label="Payment Account">
                    <SelectInput
                      reg={register("retirementExpensePaymentAccountId")}
                      options={[{ value: "", label: "Extra Savings (Default)" }, ...assetOptions]}
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
                  No homes to sell yet -- add one first via &ldquo;Add Account&rdquo; → Home on the Accounts tab.
                </p>
              ) : (
                <Field label="Which Home">
                  <SelectInput reg={register("sellRealEstateAccountId", { required: true })} options={realEstateOptions} />
                </Field>
              )}
              <div className="flex rounded-md border border-border p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setValue("sellMode", "computed")}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${sellMode === "computed" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
                >
                  Estimate for me
                </button>
                <button
                  type="button"
                  onClick={() => setValue("sellMode", "fixed")}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${sellMode === "fixed" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
                >
                  I know the net proceeds
                </button>
              </div>
              {sellMode === "computed" ? (
                <Field
                  label="Selling Costs"
                  hint="Agent commission + closing costs, as a share of the sale price -- 6 is typical. The engine credits the home's projected value at the sale date, minus these costs, minus whatever's left on its mortgage."
                >
                  <PercentInput reg={register("sellingCostsPct")} placeholder="e.g. 6" />
                </Field>
              ) : (
                <Field
                  label="Net Proceeds from Sale"
                  hint="What actually lands in your account: sale price, minus your agent's commission and closing costs, minus whatever's left on the mortgage. Can be negative if you'd owe more than the home is worth. Today's dollars."
                >
                  <MoneyInput reg={register("sellNetProceeds", { required: sellMode === "fixed" })} placeholder="e.g. 220,000" />
                </Field>
              )}
              <Field label="Proceeds Go To">
                <SelectInput
                  reg={register("sellProceedsAccountId")}
                  options={[{ value: "", label: "Extra Savings (Default)" }, ...assetOptions]}
                />
              </Field>
            </>
          )}

          {selectedType === "roth_conversion" && (
            <>
              {deferredOptions.length === 0 || rothOptions.length === 0 ? (
                <p className="text-sm text-dim">
                  A conversion needs a tax-deferred account to convert from and a Roth account to convert into. Add both on the Accounts tab first.
                </p>
              ) : (
                <FieldRow>
                  <Field label="From (tax-deferred)">
                    <SelectInput reg={register("fromAccountId", { required: true })} options={deferredOptions} />
                  </Field>
                  <Field label="To (Roth)">
                    <SelectInput reg={register("toAccountId", { required: true })} options={rothOptions} />
                  </Field>
                </FieldRow>
              )}
              <div className="flex rounded-md border border-border p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setValue("conversionMode", "amount")}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${conversionMode === "amount" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
                >
                  A set amount
                </button>
                <button
                  type="button"
                  onClick={() => setValue("conversionMode", "bracket")}
                  className={`flex-1 rounded px-3 py-1.5 font-medium ${conversionMode === "bracket" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
                >
                  Fill up to a bracket
                </button>
              </div>
              {conversionMode === "amount" ? (
                <Field label="Amount" hint="Today's dollars per conversion. The full amount lands in the Roth; the tax on it is handled per the choice below.">
                  <MoneyInput reg={register("transferAmount", { required: true })} placeholder="e.g. 40,000" />
                </Field>
              ) : (
                <Field
                  label="Fill up to the top of the"
                  hint="Each December the engine converts just enough to bring that year's ordinary taxable income (after the standard deduction) up to the top of this bracket, given the year's other income. Nothing is converted in a year that is already above it."
                >
                  <SelectInput reg={register("conversionBracket")} options={BRACKET_OPTIONS} />
                </Field>
              )}
              <FieldRow>
                <Field label="How often">
                  <SelectInput
                    reg={register("conversionFrequency")}
                    options={[
                      { value: "annual", label: "Every year" },
                      { value: "one_time", label: "Once" },
                    ]}
                  />
                </Field>
                {conversionFrequency === "annual" && (
                  <Field label="Last Year (optional)" hint="Leave blank to keep converting through the end of the plan.">
                    <TextInput reg={register("endDate")} type="date" />
                  </Field>
                )}
              </FieldRow>
              <Field
                label="Tax on the conversion is paid from"
                hint="Paying it from cash keeps the whole conversion growing tax-free, which is the usual advice. Withholding it from the conversion means less lands in the Roth."
              >
                <SelectInput
                  reg={register("conversionTaxSource")}
                  options={[
                    { value: "cash", label: "Cash (Extra Savings)" },
                    { value: "withhold", label: "The conversion itself" },
                  ]}
                />
              </Field>
              {conversionMode === "amount" && conversionFrequency === "annual" && (
                <Field label="Amount grows by" hint={`Percent per year. Blank = matches inflation (${inflationPctLabel}%); 0 = the same dollar amount every year.`}>
                  <PercentInput reg={register("transferGrowthRatePct")} placeholder={`blank = inflation (${inflationPctLabel}%)`} />
                </Field>
              )}
            </>
          )}

          {selectedType === "pay_off_loan" && (
            <>
              {loanOptions.length === 0 ? (
                <p className="text-sm text-dim">No loans or mortgages in this plan yet.</p>
              ) : (
                <FieldRow>
                  <Field label="Loan">
                    <SelectInput reg={register("loanAccountId", { required: true })} options={loanOptions} />
                  </Field>
                  <Field label="Paid from">
                    <SelectInput reg={register("fromAccountId", { required: true })} options={assetOptions} />
                  </Field>
                </FieldRow>
              )}
              <CheckboxInput reg={register("wholeBalance")} label="Pay off whatever is left on that date" />
              {!wholeBalance && (
                <Field label="Amount" hint="Today's dollars. Paying from a taxable or tax-deferred account is a sale or distribution and is taxed as one.">
                  <MoneyInput reg={register("transferAmount", { required: true })} placeholder="e.g. 50,000" />
                </Field>
              )}
            </>
          )}

          {selectedType === "rollover" && (
            <>
              {deferredOptions.length < 2 ? (
                <p className="text-sm text-dim">A rollover needs two tax-deferred accounts (for example a 401k and an IRA).</p>
              ) : (
                <FieldRow>
                  <Field label="From">
                    <SelectInput reg={register("fromAccountId", { required: true })} options={deferredOptions} />
                  </Field>
                  <Field label="To">
                    <SelectInput reg={register("toAccountId", { required: true })} options={deferredOptions} />
                  </Field>
                </FieldRow>
              )}
              <CheckboxInput reg={register("wholeBalance")} label="Move the whole balance" />
              {!wholeBalance && (
                <Field label="Amount" hint="Today's dollars.">
                  <MoneyInput reg={register("transferAmount", { required: true })} placeholder="e.g. 100,000" />
                </Field>
              )}
            </>
          )}

          {selectedType === "custom_transfer" && (
            <>
              <Field label="Amount" hint="Per occurrence, today's dollars. A move out of a taxable or tax-deferred account is taxed as a sale or distribution; use the Roth conversion, Rollover, or Pay off a loan events for those cases.">
                <MoneyInput reg={register("transferAmount", { required: true })} placeholder="e.g. 10,000" />
              </Field>
              <FieldRow>
                <Field label="From Account">
                  <SelectInput reg={register("fromAccountId", { required: true })} options={assetOptions} />
                </Field>
                <Field label="To Account">
                  <SelectInput reg={register("toAccountId", { required: true })} options={accountOptions} />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Frequency">
                  <SelectInput reg={register("transferFrequency")} options={FREQUENCY_OPTIONS} />
                </Field>
                <Field label="Or every N years" hint="Optional. Overrides the frequency: e.g. a car every 7 years.">
                  <TextInput reg={register("transferIntervalYears")} type="number" min="1" step="1" placeholder="e.g. 7" />
                </Field>
              </FieldRow>
              <Field label="End Date (optional)" hint="Leave blank to continue to the end of the plan.">
                <TextInput reg={register("endDate")} type="date" />
              </Field>
              <Field label="Annual Growth Rate" hint={`Percent per year, applied once the transfer starts. Blank = matches inflation (${inflationPctLabel}%).`}>
                <PercentInput reg={register("transferGrowthRatePct")} placeholder={`blank = inflation (${inflationPctLabel}%)`} />
              </Field>
            </>
          )}

          <Field label="Notes (optional)" hint="Why this is in the plan -- for you, and for anyone you share the plan with.">
            <TextInput reg={register("notes")} placeholder="e.g. Convert during the low-income years before Social Security" />
          </Field>
          <CheckboxInput reg={register("isExcluded")} label="Excluded (kept for reference, no effect on the projection)" />

          <DrawerFooter
            submitLabel={event ? "Save" : isWholeBalanceKind ? "Add" : "Add Event"}
            onDelete={
              event
                ? () => {
                    removeEvent(event.id);
                    onClose();
                  }
                : undefined
            }
            deleteConfirmText={`Delete ${event?.name ?? "this event"}? You can undo from the toast afterwards.`}
            left={
              <button type="button" onClick={() => setSelectedType(null)} className="text-sm text-dim hover:text-foreground">
                ← Back
              </button>
            }
          />
        </form>
      )}
    </Drawer>
  );
}
