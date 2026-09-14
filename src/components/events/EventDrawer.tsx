"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, DateAnchor, EventType, IncomeSource, Person, RecurrenceFrequency, ScenarioEvent, TemporaryAdjustment } from "@/domain";
import {
  sellHomeEventSchema,
  rothConversionEventSchema,
  payOffLoanEventSchema,
  refinanceEventSchema,
  rolloverEventSchema,
  customTransferEventSchema,
} from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import {
  ANCHOR_HINT,
  inputClass,
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
import { AnchoredDateInput } from "@/components/ui/AnchoredDate";
import { HomeDrawer } from "@/components/accounts/HomeDrawer";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { LoanDrawer } from "@/components/accounts/LoanDrawer";
import { treatmentOf } from "@/engine/resolveEvents";
import { todayISO } from "@/engine/dateMath";
import { useAssumptionsStore } from "@/store/useAssumptionsStore";
import {
  LIFE_EVENT_GROUPS,
  LIFE_EVENT_TEMPLATES,
  resolveTemplate,
  searchTemplates,
  type LifeEventTemplate,
  type ResolvedExpenseSeed,
  type ResolvedIncomeSeed,
} from "@/lib/lifeEventTemplates";

// A temporary raise/pause/cut lives directly on the income or expense it
// affects, and Social Security is a plain Income entry -- so Income and
// Expense are offered here as templates that hand off to their own drawers,
// same as Buy a home hands off to HomeDrawer. Childcare is an ordinary
// expense too (a monthly cost with an end date), so there is no separate
// "have a kid" template any more.
type TemplateType = EventType | "income" | "expense" | "heloc";

/**
 * What a picked life-event template hands off to. The generic income/expense
 * drawers open pre-filled; a temporary adjustment opens the salary it
 * changes with the change already added; Assumptions opens for the things
 * that live there (retirement age, healthcare, planning-end age).
 */
type Handoff =
  | { kind: "income"; seed: ResolvedIncomeSeed }
  | { kind: "expense"; seed: ResolvedExpenseSeed }
  | { kind: "adjust"; income: IncomeSource; adjustment: TemporaryAdjustment }
  /** More than one salary to choose between: the picker asks first. */
  | { kind: "choose-income"; template: LifeEventTemplate; candidates: IncomeSource[] };

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
  /** Refinance: percent string ("5.5"), years, money strings. */
  refiRatePct: string;
  refiTermYears: string;
  refiCashOut: string;
  refiCashOutAccountId: string;
  refiClosingCosts: string;
  refiClosingCostsFinanced: boolean;
  isExcluded: boolean;
  notes: string;
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
  refiRatePct: "",
  refiTermYears: "30",
  refiCashOut: "",
  refiCashOutAccountId: "",
  refiClosingCosts: "",
  refiClosingCostsFinanced: true,
  isExcluded: false,
  notes: "",
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
    case "open_loan":
      // Handled entirely by LoanDrawer (see the early return in the component
      // below) -- never actually reaches this form.
      return base;
    case "refinance":
      return {
        ...base,
        loanAccountId: event.loanAccountId,
        refiRatePct: fractionToPercentStr(event.annualInterestRatePct),
        refiTermYears: String(Math.round(event.termMonths / 12)),
        refiCashOut: event.cashOutAmount > 0 ? moneyToStr(event.cashOutAmount) : "",
        refiCashOutAccountId: event.cashOutAccountId ?? "",
        refiClosingCosts: event.closingCosts > 0 ? moneyToStr(event.closingCosts) : "",
        refiClosingCostsFinanced: event.closingCostsFinanced,
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

/** The event types whose form offers an end date -- the only ones an end link can apply to. */
const HAS_END_DATE = new Set<TemplateType | null>(["roth_conversion", "custom_transfer"]);

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
  incomeSources = [],
}: {
  open: boolean;
  onClose: () => void;
  event?: ScenarioEvent;
  accounts: Account[];
  people: Person[];
  /** Existing incomes, for templates that change a salary (a career break). Optional: the chart's marker editor never adds. */
  incomeSources?: IncomeSource[];
}) {
  const openAssumptions = useAssumptionsStore((s) => s.openAssumptions);
  const planStartDate = usePlanStore((s) => s.activeScenario().settings.startDate) ?? todayISO();
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  /** Which life-event template opened this form, kept so the saved event can show its own icon. */
  const [pickedTemplateId, setPickedTemplateId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const addEvent = usePlanStore((s) => s.addEvent);
  const updateEvent = usePlanStore((s) => s.updateEvent);
  const removeEvent = usePlanStore((s) => s.removeEvent);
  const inflationRatePct = usePlanStore((s) => s.activeScenario().settings.inflationRatePct);
  const inflationPctLabel = fractionToPercentStr(inflationRatePct) || "0";

  const [selectedType, setSelectedType] = useState<TemplateType | null>(event?.type ?? null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { isDirty },
  } = useForm<FormValues>({
    defaultValues: event ? eventToFormValues(event) : DEFAULTS,
  });
  // The date links live outside react-hook-form (like the adjustments above):
  // they are structured values that write into the registered date fields.
  const [startAnchor, setStartAnchor] = useState<DateAnchor | null>(event?.startAnchor ?? null);
  const [endAnchor, setEndAnchor] = useState<DateAnchor | null>(event?.endAnchor ?? null);
  const [anchorsKey, setAnchorsKey] = useState(() => JSON.stringify([event?.startAnchor ?? null, event?.endAnchor ?? null]));
  const dirty = isDirty || JSON.stringify([startAnchor, endAnchor]) !== anchorsKey;

  useEffect(() => {
    setHandoff(null);
    setQuery("");
    setPickedTemplateId(event?.templateId);
    setSelectedType(event?.type ?? null);
    reset(event ? eventToFormValues(event) : DEFAULTS);
    setStartAnchor(event?.startAnchor ?? null);
    setEndAnchor(event?.endAnchor ?? null);
    setAnchorsKey(JSON.stringify([event?.startAnchor ?? null, event?.endAnchor ?? null]));
    setError(null);
  }, [event, open, reset]);

  const opt = (list: Account[]) => list.map((a) => ({ value: a.id, label: accountOptionLabel(a, people) }));
  const accountOptions = opt(accounts);
  const assetOptions = opt(accounts.filter((a) => a.category === "asset" && a.class !== "real_estate"));
  const deferredOptions = opt(accounts.filter((a) => treatmentOf(a) === "tax_deferred"));
  const rothOptions = opt(accounts.filter((a) => treatmentOf(a) === "tax_free" && a.class !== "education_529" && a.class !== "hsa"));
  const loanOptions = opt(accounts.filter((a) => a.category === "liability"));
  const realEstateOptions = opt(accounts.filter((a) => a.class === "real_estate"));
  const sellMode = watch("sellMode");
  const conversionMode = watch("conversionMode");
  const conversionFrequency = watch("conversionFrequency");
  const wholeBalance = watch("wholeBalance");

  // buy_home, income, and expense are each handled entirely by their own
  // drawer (see the early returns below), so none of them ever reach the
  // generic form further down.
  if (handoff?.kind === "income") {
    return <IncomeDrawer open={open} onClose={onClose} income={undefined} people={people} accounts={accounts} seed={handoff.seed} />;
  }
  if (handoff?.kind === "expense") {
    return <ExpenseDrawer open={open} onClose={onClose} expense={undefined} accounts={accounts} seed={handoff.seed} />;
  }
  if (handoff?.kind === "adjust") {
    return (
      <IncomeDrawer open={open} onClose={onClose} income={handoff.income} people={people} accounts={accounts} seedAdjustment={handoff.adjustment} />
    );
  }
  if (selectedType === "buy_home") {
    const buyEvent = event?.type === "buy_home" ? event : undefined;
    const linkedAccount = buyEvent ? accounts.find((a) => a.id === buyEvent.realEstateAccountId) : undefined;
    return (
      <HomeDrawer open={open} onClose={onClose} account={linkedAccount} event={buyEvent} accounts={accounts} initialMode="buy" templateId={pickedTemplateId} />
    );
  }
  if (selectedType === "income") {
    return <IncomeDrawer open={open} onClose={onClose} income={undefined} people={people} accounts={accounts} />;
  }
  if (selectedType === "expense") {
    return <ExpenseDrawer open={open} onClose={onClose} expense={undefined} accounts={accounts} />;
  }
  if (selectedType === "open_loan" || selectedType === "heloc") {
    const loanEvent = event?.type === "open_loan" ? event : undefined;
    const loanAccount = loanEvent ? accounts.find((a) => a.id === loanEvent.loanAccountId) : undefined;
    return (
      <LoanDrawer
        open={open}
        onClose={onClose}
        account={loanAccount}
        event={loanEvent}
        accounts={accounts}
        initialMode="new"
        initialKind={selectedType === "heloc" ? "heloc" : "fixed"}
        templateId={pickedTemplateId}
      />
    );
  }

  /**
   * Picking a template preselects the pickers that have exactly one sensible
   * default -- the first tax-deferred account to convert from, the first
   * Roth to convert into, and so on -- so a fresh form is submittable as-is
   * instead of failing a silent "required" check on a blank select.
   */
  const pickLifeEvent = (template: LifeEventTemplate, income?: IncomeSource) => {
    const resolved = resolveTemplate(template, { people, accounts, planStartDate });
    switch (resolved.kind) {
      case "event":
        setPickedTemplateId(resolved.templateId);
        chooseTemplate(resolved.type);
        return;
      case "income":
      case "expense":
        setHandoff(resolved);
        return;
      case "assumptions":
        onClose();
        openAssumptions();
        return;
      case "adjustment": {
        const salaries = incomeSources.filter((i) => i.category === "salary" && !i.isExcluded);
        const target = income ?? (salaries.length === 1 ? salaries[0] : undefined);
        if (target) {
          setHandoff({ kind: "adjust", income: target, adjustment: resolved.adjustment });
        } else if (salaries.length === 0) {
          setError("There is no salary to pause yet -- add one first (Work & income → New job or raise).");
        } else {
          setHandoff({ kind: "choose-income", template, candidates: salaries });
        }
        return;
      }
    }
  };

  const chooseTemplate = (type: TemplateType) => {
    setSelectedType(type);
    setError(null);
    const first = (list: { value: string }[]) => list[0]?.value ?? "";
    const second = (list: { value: string }[]) => list[1]?.value ?? first(list);
    switch (type) {
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
      case "refinance":
        setValue("loanAccountId", first(loanOptions));
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

  const onSubmit = (v: FormValues) => {
    if (!selectedType) return;
    const base = {
      templateId: pickedTemplateId,
      name: v.name.trim(),
      startDate: v.startDate,
      isExcluded: v.isExcluded,
      notes: v.notes.trim() || undefined,
      startAnchor,
      endAnchor: HAS_END_DATE.has(selectedType) ? endAnchor : null,
    };
    let candidate: unknown;
    let schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

    const growthIssue = implausibleRateMessage("The growth rate", percentStrToFraction(v.transferGrowthRatePct));
    if (growthIssue) {
      setError(growthIssue);
      return;
    }
    switch (selectedType) {
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
      case "refinance": {
        const termYears = Number(v.refiTermYears);
        if (!Number.isFinite(termYears) || termYears <= 0) {
          setError("Enter the new term in years.");
          return;
        }
        const rate = percentStrToFraction(v.refiRatePct);
        if (rate == null) {
          setError("Enter the new interest rate.");
          return;
        }
        candidate = {
          ...base,
          type: "refinance",
          loanAccountId: v.loanAccountId,
          annualInterestRatePct: rate,
          termMonths: Math.round(termYears * 12),
          cashOutAmount: moneyStrToNumber(v.refiCashOut) ?? 0,
          cashOutAccountId: v.refiCashOutAccountId || null,
          closingCosts: moneyStrToNumber(v.refiClosingCosts) ?? 0,
          closingCostsFinanced: v.refiClosingCostsFinanced,
          extraPrincipalMonthly: null,
        };
        schema = refinanceEventSchema.omit({ id: true });
        break;
      }
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
    <Drawer open={open} onClose={onClose} title={event ? "Edit Event" : "Add a life event"} dirty={selectedType !== null && dirty}>
      {!selectedType ? (
        <div className="flex flex-col gap-3">
          <ErrorBanner message={error} />
          {handoff?.kind === "choose-income" ? (
            <>
              <p className="text-sm text-dim">Which salary does this apply to?</p>
              {handoff.candidates.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => pickLifeEvent(handoff.template, i)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent"
                >
                  <div className="text-sm font-medium">{i.name}</div>
                </button>
              ))}
              <button type="button" onClick={() => setHandoff(null)} className="text-left text-xs text-dim hover:text-foreground">
                ← Back
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search life events -- baby, college, car, retire..."
                className={inputClass}
                autoFocus
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => chooseTemplate("income")} className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent">
                  <div className="text-sm font-medium">Income</div>
                  <div className="text-xs text-dim">Blank -- any money coming in</div>
                </button>
                <button type="button" onClick={() => chooseTemplate("expense")} className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent">
                  <div className="text-sm font-medium">Expense</div>
                  <div className="text-xs text-dim">Blank -- any money going out</div>
                </button>
              </div>
              {(() => {
                const matches = searchTemplates(query, LIFE_EVENT_TEMPLATES);
                if (matches.length === 0) return <p className="text-sm text-dim">Nothing matches. Try a plain Income or Expense above.</p>;
                return LIFE_EVENT_GROUPS.map((group) => {
                  const items = matches.filter((t) => t.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group} className="flex flex-col gap-1.5">
                      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-dim/70">{group}</div>
                      {items.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => pickLifeEvent(t)}
                          className="rounded-md border border-border bg-background px-3 py-2 text-left hover:border-accent"
                        >
                          <div className="text-sm font-medium">{t.label}</div>
                          <div className="text-xs text-dim">{t.hint}</div>
                        </button>
                      ))}
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="flex flex-col gap-3">
          <ErrorBanner message={error} />
          <Field label="Name">
            <TextInput reg={register("name", { required: true })} />
          </Field>

          <Field
            label={selectedType === "roth_conversion" && conversionFrequency === "annual" ? "First Year (date)" : "Date"}
            hint={ANCHOR_HINT}
          >
            <AnchoredDateInput
              reg={register("startDate", { required: true })}
              anchor={startAnchor}
              onAnchorChange={setStartAnchor}
              onResolve={(d) => setValue("startDate", d, { shouldDirty: true })}
              people={people}
              kind="start"
            />
          </Field>

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
                  <Field
                    label="Last Year (optional)"
                    hint="Leave blank to keep converting through the end of the plan. Linked to a retirement, the window closes the day before it (e.g. convert until Social Security starts)."
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

          {selectedType === "refinance" && (
            <>
              {loanOptions.length === 0 ? (
                <p className="text-sm text-dim">No loans or mortgages in this plan yet.</p>
              ) : (
                <>
                  <Field label="Loan" hint="Its balance carries over -- only the rate and term change.">
                    <SelectInput reg={register("loanAccountId", { required: true })} options={loanOptions} />
                  </Field>
                  <FieldRow>
                    <Field label="New Interest Rate (per year)">
                      <PercentInput reg={register("refiRatePct", { required: true })} placeholder="e.g. 5.5" />
                    </Field>
                    <Field label="New Term (years)" hint="Counted from the closing date above.">
                      <TextInput reg={register("refiTermYears", { required: true })} type="number" step="1" min="1" />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field label="Cash Out (optional)" hint="Added to what you owe and paid to you. Today's dollars.">
                      <MoneyInput reg={register("refiCashOut")} placeholder="e.g. 50,000" />
                    </Field>
                    <Field label="Closing Costs (optional)" hint="Lender fees, title, points. Today's dollars.">
                      <MoneyInput reg={register("refiClosingCosts")} placeholder="e.g. 6,000" />
                    </Field>
                  </FieldRow>
                  <CheckboxInput
                    reg={register("refiClosingCostsFinanced")}
                    label="Roll the closing costs into the loan (uncheck to pay them at closing)"
                  />
                  <Field label="Cash Goes To" hint="Where a cash-out lands, and where closing costs are paid from when you don't roll them in.">
                    <SelectInput
                      reg={register("refiCashOutAccountId")}
                      options={[{ value: "", label: "Extra Savings (Default)" }, ...assetOptions]}
                    />
                  </Field>
                </>
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
              <Field
                label="End Date (optional)"
                hint="Leave blank to continue to the end of the plan. Linked to a retirement, the last transfer lands the day before it."
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
