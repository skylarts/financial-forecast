"use client";

import { useState } from "react";
import type { FilingStatus, Person, Scenario } from "@/domain";
import { forecastSettingsSchema, personSchema } from "@/domain";
import { usePlanStore, planHasContent } from "@/store/usePlanStore";
import { Field, ErrorBanner, PercentInput, MoneyInput, inputClass } from "@/components/ui/formFields";
import { percentStrToFraction, fractionToPercentStr } from "@/lib/inputFormat";
import { formatMoney } from "@/lib/format";
import { todayISO } from "@/engine/dateMath";
import { AccountDrawer } from "@/components/accounts/AccountDrawer";
import { addExistingHome, EXISTING_HOME_DEFAULTS } from "@/lib/addExistingHome";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";
import { MoneyFlowEditor } from "@/components/moneyflow/MoneyFlowEditor";
import { STRATEGY_LABELS } from "@/engine/strategy";
import { freqLabel } from "@/lib/timelineFormat";

type Step =
  | "welcome"
  | "person-self"
  | "person-more"
  | "person-add"
  | "retirement"
  | "assumptions"
  | "accounts"
  | "home-owned"
  | "income"
  | "expenses"
  | "routing"
  | "events"
  | "review";

const SECTIONS: { label: string; steps: Step[] }[] = [
  { label: "Welcome", steps: ["welcome"] },
  { label: "About you", steps: ["person-self", "person-more", "person-add"] },
  { label: "Retirement", steps: ["retirement"] },
  { label: "Assumptions", steps: ["assumptions"] },
  { label: "Accounts", steps: ["accounts", "home-owned"] },
  { label: "Income", steps: ["income"] },
  { label: "Expenses", steps: ["expenses"] },
  { label: "Withdrawals", steps: ["routing"] },
  { label: "Life events", steps: ["events"] },
  { label: "Review", steps: ["review"] },
];

const optionButtonClass = "rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:border-accent";
const primaryButtonClass = "rounded-md bg-pri px-4 py-2 text-sm font-semibold text-pri-fg disabled:opacity-50";
const secondaryButtonClass = "rounded-md border border-border px-4 py-2 text-sm text-dim hover:text-foreground";

function defaultBirthDate(): string {
  return `${new Date().getFullYear() - 35}-01-01`;
}

/** What is wrong with a person's ages, or null. Mirrors the Assumptions drawer's rule. */
function ageIssue(p: { retirementAge: number; planningEndAge: number }): string | null {
  if (!Number.isInteger(p.retirementAge) || p.retirementAge < 18 || p.retirementAge > 100) return "Retirement age should be a whole number between 18 and 100.";
  if (!Number.isInteger(p.planningEndAge) || p.planningEndAge > 120) return "Plan-through age should be a whole number up to 120.";
  if (p.planningEndAge < p.retirementAge) return "Plan-through age should be at or after the retirement age.";
  return null;
}

/**
 * The guided setup. It edits the plan directly (every drawer it opens is the
 * app's own), so nothing is lost by closing early and reopening: the guide
 * picks the plan back up where it is. On an empty plan it fills in the
 * scenario that is already there; on a plan with content it asks whether to
 * edit that plan or start a new scenario alongside it.
 */
export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addBlankScenario = usePlanStore((s) => s.addBlankScenario);
  const renameScenario = usePlanStore((s) => s.renameScenario);
  const updatePerson = usePlanStore((s) => s.updatePerson);
  const addPerson = usePlanStore((s) => s.addPerson);
  const removePerson = usePlanStore((s) => s.removePerson);
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const plan = usePlanStore((s) => s.plan);
  const activeScenario = usePlanStore((s) => s.activeScenario());

  const [step, setStep] = useState<Step>("welcome");
  const [history, setHistory] = useState<Step[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const scenario = usePlanStore((s) => s.plan.scenarios.find((sc) => sc.id === scenarioId) ?? null);
  const [retirementIndex, setRetirementIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [planName, setPlanName] = useState("My Plan");
  const [selfName, setSelfName] = useState("");
  const [selfBirthDate, setSelfBirthDate] = useState(defaultBirthDate());
  const [newName, setNewName] = useState("");
  const [newBirthDate, setNewBirthDate] = useState(defaultBirthDate());
  /** Ages being typed for the retirement step, committed on Continue. */
  const [ageDraft, setAgeDraft] = useState<{ retirementAge: string; planningEndAge: string } | null>(null);

  /** Percent strings. */
  const [inflationRatePct, setInflationRatePct] = useState("3");
  const [filingStatus, setFilingStatus] = useState<FilingStatus>("single");
  const [additionalFlatTaxRatePct, setAdditionalFlatTaxRatePct] = useState("0");
  const [planReturnPct, setPlanReturnPct] = useState("6");
  const [usePlanReturn, setUsePlanReturn] = useState(true);
  const [modelHealthcare, setModelHealthcare] = useState(true);

  const [homeValue, setHomeValue] = useState("");
  const [homeGrowthRatePct, setHomeGrowthRatePct] = useState(EXISTING_HOME_DEFAULTS.homeGrowthRatePct);
  const [hasMortgage, setHasMortgage] = useState(false);
  const [mortgageBalance, setMortgageBalance] = useState("");
  const [mortgageRate, setMortgageRate] = useState(EXISTING_HOME_DEFAULTS.mortgageRate);
  const [mortgageYearsLeft, setMortgageYearsLeft] = useState(EXISTING_HOME_DEFAULTS.mortgageYearsLeft);

  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false);
  const [incomeDrawerOpen, setIncomeDrawerOpen] = useState(false);
  const [expenseDrawerOpen, setExpenseDrawerOpen] = useState(false);
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);

  if (!open) return null;

  const go = (next: Step) => {
    setHistory((h) => [...h, step]);
    setStep(next);
    setError(null);
  };
  const back = () => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) setStep(prev);
      return h.slice(0, -1);
    });
    setError(null);
  };

  const resetLocalState = () => {
    setStep("welcome");
    setHistory([]);
    setScenarioId(null);
    setRetirementIndex(0);
    setError(null);
    setPlanName("My Plan");
    setSelfName("");
    setSelfBirthDate(defaultBirthDate());
    setNewName("");
    setNewBirthDate(defaultBirthDate());
    setAgeDraft(null);
    setInflationRatePct("3");
    setFilingStatus("single");
    setAdditionalFlatTaxRatePct("0");
    setPlanReturnPct("6");
    setUsePlanReturn(true);
    setModelHealthcare(true);
    setHomeValue("");
    setHomeGrowthRatePct(EXISTING_HOME_DEFAULTS.homeGrowthRatePct);
    setHasMortgage(false);
    setMortgageBalance("");
    setMortgageRate(EXISTING_HOME_DEFAULTS.mortgageRate);
    setMortgageYearsLeft(EXISTING_HOME_DEFAULTS.mortgageYearsLeft);
  };

  const handleClose = () => {
    resetLocalState();
    onClose();
  };

  /** Seed the guide's own fields from a scenario being edited. */
  const beginWith = (target: Scenario) => {
    setScenarioId(target.id);
    const first = target.household.people[0];
    if (first) {
      setSelfName(first.name === "You" ? "" : first.name);
      setSelfBirthDate(first.birthDate);
    }
    setInflationRatePct(fractionToPercentStr(target.settings.inflationRatePct) || "3");
    setFilingStatus(target.settings.filingStatus);
    setAdditionalFlatTaxRatePct(fractionToPercentStr(target.settings.additionalFlatTaxRatePct) || "0");
    setUsePlanReturn(target.settings.planReturnRatePct != null || !planHasContent(plan));
    setPlanReturnPct(target.settings.planReturnRatePct != null ? fractionToPercentStr(target.settings.planReturnRatePct) : "6");
    setModelHealthcare(planHasContent(plan) ? target.settings.healthcare.enabled : true);
    go("person-self");
  };

  const handleStartFresh = () => {
    const name = planName.trim() || "My Plan";
    if (!planHasContent(plan)) {
      // The empty starting scenario is the plan: fill it in rather than
      // leaving an empty "My Plan" behind a second one.
      renameScenario(activeScenario.id, name);
      beginWith({ ...activeScenario, name });
      return;
    }
    const id = addBlankScenario(name);
    const created = usePlanStore.getState().plan.scenarios.find((s) => s.id === id);
    if (created) beginWith(created);
  };

  const handleEditCurrent = () => beginWith(activeScenario);

  const handleSelfContinue = () => {
    if (!scenario) return;
    const self = scenario.household.people[0];
    if (!self) return;
    if (!selfName.trim() || !selfBirthDate) {
      setError("Enter your name and date of birth to continue.");
      return;
    }
    const candidate = { name: selfName.trim(), birthDate: selfBirthDate, retirementAge: self.retirementAge, planningEndAge: self.planningEndAge };
    const result = personSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "That doesn't look right.");
      return;
    }
    updatePerson(self.id, result.data);
    go("person-more");
  };

  const handleAddPerson = () => {
    if (!newName.trim() || !newBirthDate) {
      setError("Enter a name and date of birth.");
      return;
    }
    const candidate = { name: newName.trim(), birthDate: newBirthDate, retirementAge: 65, planningEndAge: 95 };
    const result = personSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "That doesn't look right.");
      return;
    }
    addPerson(result.data);
    setNewName("");
    setNewBirthDate(defaultBirthDate());
    setHistory((h) => h.slice(0, -1));
    setStep("person-more");
    setError(null);
  };

  const people = scenario?.household.people ?? [];
  const currentPerson: Person | undefined = people[retirementIndex];
  const draftFor = (p: Person) => ageDraft ?? { retirementAge: String(p.retirementAge), planningEndAge: String(p.planningEndAge) };

  const handleRetirementContinue = () => {
    if (!currentPerson) return;
    const draft = draftFor(currentPerson);
    const ages = { retirementAge: Number(draft.retirementAge), planningEndAge: Number(draft.planningEndAge) };
    const issue = ageIssue(ages);
    if (issue) {
      setError(issue);
      return;
    }
    const updated = { ...currentPerson, ...ages };
    // Saving the age IS saving the retirement: the engine reads it off the
    // person, so there is no second thing to create and keep in step.
    updatePerson(currentPerson.id, { name: updated.name, birthDate: updated.birthDate, retirementAge: ages.retirementAge, planningEndAge: ages.planningEndAge });
    setAgeDraft(null);
    setError(null);
    if (retirementIndex + 1 < people.length) {
      setRetirementIndex(retirementIndex + 1);
      return;
    }
    if (!planHasContent(plan) || scenario?.settings.filingStatus === undefined) setFilingStatus(people.length > 1 ? "marriedFilingJointly" : "single");
    go("assumptions");
  };

  const handleAssumptionsContinue = () => {
    if (!scenario) return;
    const inflation = percentStrToFraction(inflationRatePct);
    if (inflation === null || inflation > 0.25 || inflation < -0.05) {
      setError("Inflation should be a percent like 3 for 3% a year.");
      return;
    }
    const planReturn = usePlanReturn ? percentStrToFraction(planReturnPct) : null;
    if (usePlanReturn && (planReturn === null || Math.abs(planReturn) > 0.5)) {
      setError("The expected return should be a percent like 6 for 6% a year.");
      return;
    }
    const horizonYear = Math.max(...scenario.household.people.map((p) => Number(p.birthDate.slice(0, 4)) + p.planningEndAge));
    const candidate = {
      ...scenario.settings,
      // Live "today": balances are treated as of whenever the plan is opened.
      startDate: null,
      horizonEndDate: `${horizonYear}-12-31`,
      inflationRatePct: inflation,
      filingStatus,
      additionalFlatTaxRatePct: percentStrToFraction(additionalFlatTaxRatePct) ?? 0,
      planReturnRatePct: planReturn,
      healthcare: { ...scenario.settings.healthcare, enabled: modelHealthcare },
    };
    const result = forecastSettingsSchema.safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "That doesn't look right.");
      return;
    }
    updateSettings(result.data);
    go("accounts");
  };

  const handleAddHome = () => {
    if (!scenario || !scenarioId) return;
    const result = addExistingHome(
      // The guide keeps onboarding lean; tax, insurance and upkeep take the
      // same defaults the Accounts tab uses and can be tuned there.
      { ...EXISTING_HOME_DEFAULTS, homeValue, homeGrowthRatePct, hasMortgage, mortgageBalance, mortgageRate, mortgageYearsLeft },
      scenario.settings.startDate ?? todayISO()
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setHomeValue("");
    setMortgageBalance("");
    setHasMortgage(false);
    setHistory((h) => h.slice(0, -1));
    setStep("accounts");
    setError(null);
  };

  const sectionIndex = SECTIONS.findIndex((sec) => sec.steps.includes(step));
  const nonHubAccounts = scenario?.accounts.filter((a) => !a.isExtraSavings) ?? [];
  const editingExisting = planHasContent(plan) && scenarioId === plan.activeScenarioId && history.length > 0;

  const nav = (next: { label: string; onClick: () => void; disabled?: boolean }, showBack = true) => (
    <div className="mt-2 flex items-center justify-between gap-2">
      {showBack && history.length > 0 ? (
        <button type="button" onClick={back} className={secondaryButtonClass}>
          ← Back
        </button>
      ) : (
        <span />
      )}
      <button type="button" onClick={next.onClick} disabled={next.disabled} className={primaryButtonClass}>
        {next.label}
      </button>
    </div>
  );

  const added = (items: { name: string; detail?: string }[]) =>
    items.length > 0 && (
      <ul className="flex flex-col gap-1 text-xs text-dim">
        {items.map((it, i) => (
          <li key={i} className="flex justify-between gap-3 rounded-md border border-border-soft bg-panel-2/40 px-2.5 py-1.5">
            <span className="truncate text-foreground">{it.name}</span>
            {it.detail && <span className="shrink-0 font-mono tabular-nums">{it.detail}</span>}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-y-auto rounded-lg border border-border bg-panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-dim">
              Step {sectionIndex + 1} of {SECTIONS.length} · {SECTIONS[sectionIndex]?.label}
              {editingExisting && scenario && <span className="ml-2 normal-case tracking-normal text-dim-2">· editing {scenario.name}</span>}
            </div>
            <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-background">
              <div className="h-full bg-pri transition-all" style={{ width: `${((sectionIndex + 1) / SECTIONS.length) * 100}%` }} />
            </div>
          </div>
          <button type="button" onClick={handleClose} className="rounded-md px-2 py-1 text-dim hover:bg-background hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>

        <ErrorBanner message={error} />

        <div className="flex flex-col gap-4">
          {step === "welcome" && (
            <>
              <h2 className="text-lg font-semibold">Set up your plan</h2>
              <p className="text-sm text-dim">
                A few questions about your household, accounts, income, and expenses, and the forecast takes it from there. Nothing here is permanent:
                every answer is an ordinary entry in the plan, so you can change it later or close this at any point and come back.
              </p>
              {planHasContent(plan) ? (
                <div className="flex flex-col gap-2">
                  <button type="button" onClick={handleEditCurrent} className={optionButtonClass}>
                    <div className="font-medium">Walk through “{activeScenario.name}” again</div>
                    <div className="text-xs text-dim">Review and change what is already there, step by step.</div>
                  </button>
                  <div className={`${optionButtonClass} flex flex-col gap-2`}>
                    <div className="font-medium">Start a new scenario</div>
                    <div className="text-xs text-dim">A separate plan alongside the current one, to compare against it.</div>
                    <div className="flex gap-2">
                      <input className={inputClass} value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="Scenario name" />
                      <button type="button" onClick={handleStartFresh} className={primaryButtonClass}>
                        Start
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <Field label="What should we call this plan?">
                    <input className={inputClass} value={planName} onChange={(e) => setPlanName(e.target.value)} />
                  </Field>
                  {nav({ label: "Let’s get started →", onClick: handleStartFresh }, false)}
                </>
              )}
            </>
          )}

          {step === "person-self" && (
            <>
              <h2 className="text-lg font-semibold">About you</h2>
              <p className="text-sm text-dim">Your name and date of birth. Age drives retirement, penalty-free access at 59½, Medicare at 65 and required withdrawals later on.</p>
              <Field label="Your name">
                <input className={inputClass} value={selfName} onChange={(e) => setSelfName(e.target.value)} placeholder="e.g. Alex" />
              </Field>
              <Field label="Date of birth">
                <input className={inputClass} type="date" value={selfBirthDate} onChange={(e) => setSelfBirthDate(e.target.value)} />
              </Field>
              {nav({ label: "Continue →", onClick: handleSelfContinue })}
            </>
          )}

          {step === "person-more" && (
            <>
              <h2 className="text-lg font-semibold">{people.length > 1 ? "Anyone else to add?" : "Anyone else in this plan?"}</h2>
              <p className="text-sm text-dim">
                {people.length > 1
                  ? "Add as many people as apply, or continue once everyone's in."
                  : "Is this plan just for you, or is someone else's money part of it too: a spouse, partner, or anyone you manage finances jointly with?"}
              </p>
              {people.length > 1 &&
                added(
                  people.map((p) => ({
                    name: p.name,
                    detail: p.birthDate,
                  }))
                )}
              {people.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {people.slice(1).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        if (!removePerson(p.id)) setError(`${p.name} still owns an account, income or event; remove those first.`);
                      }}
                      className="text-xs text-negative hover:underline"
                    >
                      Remove {p.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => go("person-add")} className={optionButtonClass}>
                  {people.length > 1 ? "Yes, add another person" : "Yes, add someone else"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRetirementIndex(0);
                    setAgeDraft(null);
                    go("retirement");
                  }}
                  className={optionButtonClass}
                >
                  {people.length > 1 ? "No, that's everyone" : "No, just me"}
                </button>
              </div>
              {history.length > 0 && (
                <div>
                  <button type="button" onClick={back} className={secondaryButtonClass}>
                    ← Back
                  </button>
                </div>
              )}
            </>
          )}

          {step === "person-add" && (
            <>
              <h2 className="text-lg font-semibold">Add someone else</h2>
              <Field label="Their name">
                <input className={inputClass} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Jordan" />
              </Field>
              <Field label="Their date of birth">
                <input className={inputClass} type="date" value={newBirthDate} onChange={(e) => setNewBirthDate(e.target.value)} />
              </Field>
              {nav({ label: "Add", onClick: handleAddPerson })}
            </>
          )}

          {step === "retirement" && currentPerson && (
            <>
              <h2 className="text-lg font-semibold">Retirement — {currentPerson.name || "this person"}</h2>
              <Field label="At what age would they like to retire?" hint="If you're not sure, 65 is a common starting point. This creates a Retire event on that birthday, which is what stops the salary.">
                <input
                  className={inputClass}
                  type="number"
                  value={draftFor(currentPerson).retirementAge}
                  onChange={(e) => setAgeDraft({ ...draftFor(currentPerson), retirementAge: e.target.value })}
                />
              </Field>
              <Field label="Plan through what age?" hint="The age the plan models them living to. Most people use 90-95 so the plan doesn't run out of runway before they do.">
                <input
                  className={inputClass}
                  type="number"
                  value={draftFor(currentPerson).planningEndAge}
                  onChange={(e) => setAgeDraft({ ...draftFor(currentPerson), planningEndAge: e.target.value })}
                />
              </Field>
              {nav({
                label: retirementIndex + 1 < people.length ? `Next: ${people[retirementIndex + 1].name} →` : "Continue →",
                onClick: handleRetirementContinue,
              })}
            </>
          )}

          {step === "assumptions" && (
            <>
              <h2 className="text-lg font-semibold">A few money assumptions</h2>
              <p className="text-sm text-dim">These have sensible defaults; feel free to just continue. All of them live under Assumptions afterwards.</p>
              <Field label="Inflation rate (per year)" hint="Percent per year, e.g. 3 for 3%. Also the default growth for anything you leave blank later.">
                <PercentInput value={inflationRatePct} placeholder="e.g. 3" onChange={(e) => setInflationRatePct(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" className="h-4 w-4" checked={usePlanReturn} onChange={(e) => setUsePlanReturn(e.target.checked)} />
                Use one expected return for every investment account
              </label>
              {usePlanReturn ? (
                <Field label="Expected investment return (per year)" hint="Nominal, before inflation. A balanced portfolio has historically returned 6-7% a year. Each account can carry its own rate instead: turn this off in Assumptions later.">
                  <PercentInput value={planReturnPct} placeholder="e.g. 6" onChange={(e) => setPlanReturnPct(e.target.value)} />
                </Field>
              ) : (
                <p className="text-xs text-dim">Each account will use the growth rate you give it (blank = inflation).</p>
              )}
              <Field label="Filing status">
                <select className={inputClass} value={filingStatus} onChange={(e) => setFilingStatus(e.target.value as FilingStatus)}>
                  <option value="single">Single</option>
                  <option value="marriedFilingJointly">Married filing jointly</option>
                </select>
              </Field>
              <Field label="Extra flat tax rate (optional)" hint="State or local income tax, as a flat add-on in percent (e.g. 5 for 5%). Leave at 0 if unsure.">
                <PercentInput value={additionalFlatTaxRatePct} placeholder="e.g. 5" onChange={(e) => setAdditionalFlatTaxRatePct(e.target.value)} />
              </Field>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={modelHealthcare} onChange={(e) => setModelHealthcare(e.target.checked)} />
                <span>
                  Model healthcare costs
                  <span className="block text-xs text-dim">
                    Premiums and out-of-pocket costs by stage: an employer plan while working, a marketplace plan before 65 with the premium credit from your own income, Medicare after. Tune the figures under Assumptions › Healthcare. If you turn this off, enter healthcare as ordinary expenses.
                  </span>
                </span>
              </label>
              <p className="text-xs text-dim">
                Balances are treated as of today whenever the plan is opened. Required withdrawals from retirement accounts are modelled automatically.
              </p>
              {nav({ label: "Continue →", onClick: handleAssumptionsContinue })}
            </>
          )}

          {step === "accounts" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Accounts</h2>
              <p className="text-sm text-dim">Bank accounts, investments, retirement accounts, and any debts like credit cards or loans. Add as many as apply, one at a time.</p>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => setAccountDrawerOpen(true)} className={optionButtonClass}>
                  + Add a bank, investment, retirement, or debt account
                </button>
                <button type="button" onClick={() => go("home-owned")} className={optionButtonClass}>
                  + Add a home you already own
                </button>
              </div>
              {added(nonHubAccounts.map((a) => ({ name: a.name, detail: formatMoney((a.category === "liability" ? -1 : 1) * a.startingBalance) })))}
              {nonHubAccounts.length === 0 && <p className="text-xs text-dim">Add at least one account to continue: a forecast needs somewhere to start from.</p>}
              {nav({ label: "Continue →", onClick: () => go("income"), disabled: nonHubAccounts.length === 0 })}
            </>
          )}

          {step === "home-owned" && (
            <>
              <h2 className="text-lg font-semibold">A home you already own</h2>
              <p className="text-xs text-dim">Buying a home in the future is a life event, later on. This is only for a home you own today.</p>
              <Field label="Current estimated value">
                <MoneyInput value={homeValue} placeholder="e.g. 450,000" onChange={(e) => setHomeValue(e.target.value)} />
              </Field>
              <Field label="Annual appreciation rate" hint="Percent per year, e.g. 3 for 3%. Blank = matches inflation.">
                <PercentInput value={homeGrowthRatePct} placeholder="blank = inflation" onChange={(e) => setHomeGrowthRatePct(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" className="h-4 w-4" checked={hasMortgage} onChange={(e) => setHasMortgage(e.target.checked)} />
                Still have a mortgage on it
              </label>
              {hasMortgage && (
                <div className="flex flex-col gap-3 border-l border-border pl-3">
                  <Field label="Remaining balance">
                    <MoneyInput value={mortgageBalance} placeholder="e.g. 320,000" onChange={(e) => setMortgageBalance(e.target.value)} />
                  </Field>
                  <Field label="Interest rate (per year)">
                    <PercentInput value={mortgageRate} placeholder="e.g. 6.5" onChange={(e) => setMortgageRate(e.target.value)} />
                  </Field>
                  <Field label="Years remaining">
                    <input className={inputClass} type="number" step="1" value={mortgageYearsLeft} onChange={(e) => setMortgageYearsLeft(e.target.value)} />
                  </Field>
                </div>
              )}
              <p className="text-xs text-dim">Property tax, insurance and upkeep start at 1%, 0.5% and 1% of the value a year; adjust them on the Accounts tab.</p>
              {nav({ label: "Add home", onClick: handleAddHome })}
            </>
          )}

          {step === "income" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Income</h2>
              <p className="text-sm text-dim">Salary as take-home pay, Social Security, pensions, rental income: anything regular. A plan with no income shows money running out from day one.</p>
              <button type="button" onClick={() => setIncomeDrawerOpen(true)} className={optionButtonClass}>
                + Add income
              </button>
              {added(scenario.incomeSources.map((i) => ({ name: i.name, detail: `${formatMoney(i.amount)}${freqLabel(i.frequency, i.intervalYears)}` })))}
              {scenario.incomeSources.length === 0 && <p className="text-xs text-dim">Add at least one income to continue.</p>}
              {nav({ label: "Continue →", onClick: () => go("expenses"), disabled: scenario.incomeSources.length === 0 })}
            </>
          )}

          {step === "expenses" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Expenses</h2>
              <p className="text-sm text-dim">
                Regular spending: housing, transportation, food, childcare, anything recurring. One &ldquo;living expenses&rdquo; line is fine to start.
                {modelHealthcare && " Healthcare premiums are modelled for you; enter only what the model does not cover."}
              </p>
              <button type="button" onClick={() => setExpenseDrawerOpen(true)} className={optionButtonClass}>
                + Add expense
              </button>
              {added(scenario.expenses.map((e) => ({ name: e.name, detail: `${formatMoney(e.amount)}${freqLabel(e.frequency, e.intervalYears)}` })))}
              {scenario.expenses.length === 0 && <p className="text-xs text-dim">Add at least one expense to continue: without spending the plan just grows forever.</p>}
              {nav({ label: "Continue →", onClick: () => go("routing"), disabled: scenario.expenses.length === 0 })}
            </>
          )}

          {step === "routing" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Where money goes</h2>
              <p className="text-sm text-dim">
                When there is extra cash, where should it go? And when spending outruns income, which accounts cover the gap, and in what order? The plan starts on{" "}
                <span className="text-foreground">{STRATEGY_LABELS[scenario.settings.withdrawalStrategy]}</span>, which follows the accounts you added; change it here or on the Routing tab any time.
              </p>
              <MoneyFlowEditor accounts={scenario.accounts} settings={scenario.settings} />
              {nav({ label: "Continue →", onClick: () => go("events") })}
            </>
          )}

          {step === "events" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Life events</h2>
              <p className="text-sm text-dim">
                Anything specific coming up: buying or selling a home, a Roth conversion, paying off a loan, a big one-time cost. Retirement is
                already in, from the ages you set: {" "}
                {scenario.household.people.map((p) => `${p.name} at ${p.retirementAge}`).join(", ")}. Optional.
              </p>
              <button type="button" onClick={() => setEventDrawerOpen(true)} className={optionButtonClass}>
                + Add a life event
              </button>
              {added(scenario.events.map((e) => ({ name: e.name, detail: e.startDate })))}
              {nav({ label: "Finish setup →", onClick: () => go("review") })}
            </>
          )}

          {step === "review" && scenario && (
            <>
              <h2 className="text-lg font-semibold">You&rsquo;re all set</h2>
              <p className="text-sm text-dim">Here&rsquo;s what&rsquo;s in &ldquo;{scenario.name}&rdquo;:</p>
              <ul className="list-inside list-disc text-sm text-foreground">
                <li>
                  {scenario.household.people.length} {scenario.household.people.length === 1 ? "person" : "people"}
                </li>
                <li>
                  {nonHubAccounts.length} account{nonHubAccounts.length === 1 ? "" : "s"}
                </li>
                <li>
                  {scenario.incomeSources.length} income source{scenario.incomeSources.length === 1 ? "" : "s"}
                </li>
                <li>
                  {scenario.expenses.length} expense{scenario.expenses.length === 1 ? "" : "s"}
                </li>
                <li>
                  {scenario.events.length} life event{scenario.events.length === 1 ? "" : "s"}
                </li>
                <li>Withdrawals: {STRATEGY_LABELS[scenario.settings.withdrawalStrategy]}</li>
                <li>Healthcare model: {scenario.settings.healthcare.enabled ? "on" : "off"}</li>
              </ul>
              <p className="text-sm text-dim">
                Everything here can be changed any time. To test a different assumption later, such as retiring two years earlier, duplicate this plan from the scenario menu and adjust the copy, then compare them side by side. The Stress test tab shows how it holds up under worse conditions.
              </p>
              {nav({ label: "Take me to my forecast", onClick: handleClose })}
            </>
          )}
        </div>
      </div>

      {scenario && (
        <>
          <AccountDrawer open={accountDrawerOpen} onClose={() => setAccountDrawerOpen(false)} people={scenario.household.people} accounts={scenario.accounts} />
          <IncomeDrawer open={incomeDrawerOpen} onClose={() => setIncomeDrawerOpen(false)} people={scenario.household.people} accounts={scenario.accounts} />
          <ExpenseDrawer open={expenseDrawerOpen} onClose={() => setExpenseDrawerOpen(false)} accounts={scenario.accounts} />
          <EventDrawer open={eventDrawerOpen} onClose={() => setEventDrawerOpen(false)} accounts={scenario.accounts} people={scenario.household.people} />
        </>
      )}
    </div>
  );
}
