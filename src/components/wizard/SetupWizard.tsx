"use client";

import { useState } from "react";
import type { FilingStatus, Person } from "@/domain";
import { forecastSettingsSchema, personSchema } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { Field, ErrorBanner, inputClass } from "@/components/ui/formFields";
import { AccountDrawer } from "@/components/accounts/AccountDrawer";
import { addExistingHome, EXISTING_HOME_DEFAULTS } from "@/lib/addExistingHome";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";
import { MoneyFlowEditor } from "@/components/moneyflow/MoneyFlowEditor";

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
  { label: "About You", steps: ["person-self", "person-more", "person-add"] },
  { label: "Retirement", steps: ["retirement"] },
  { label: "Assumptions", steps: ["assumptions"] },
  { label: "Accounts", steps: ["accounts", "home-owned"] },
  { label: "Income", steps: ["income"] },
  { label: "Expenses", steps: ["expenses"] },
  { label: "Money Flow", steps: ["routing"] },
  { label: "Life Events", steps: ["events"] },
  { label: "Review", steps: ["review"] },
];

const optionButtonClass =
  "rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:border-accent";
const primaryButtonClass =
  "rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const secondaryButtonClass = "rounded-md border border-border px-4 py-2 text-sm text-dim hover:text-foreground";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultBirthDate(): string {
  return `${new Date().getFullYear() - 35}-01-01`;
}

export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addBlankScenario = usePlanStore((s) => s.addBlankScenario);
  const updatePerson = usePlanStore((s) => s.updatePerson);
  const addPerson = usePlanStore((s) => s.addPerson);
  const updateSettings = usePlanStore((s) => s.updateSettings);

  const [step, setStep] = useState<Step>("welcome");
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const scenario = usePlanStore((s) => s.plan.scenarios.find((sc) => sc.id === scenarioId) ?? null);
  const [selfPersonId, setSelfPersonId] = useState<string | null>(null);
  const [retirementIndex, setRetirementIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [planName, setPlanName] = useState("My Plan");

  const [selfName, setSelfName] = useState("");
  const [selfBirthDate, setSelfBirthDate] = useState(defaultBirthDate());

  const [newName, setNewName] = useState("");
  const [newBirthDate, setNewBirthDate] = useState(defaultBirthDate());

  const [startDate, setStartDate] = useState(todayISO());
  const [inflationRatePct, setInflationRatePct] = useState(0.03);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>("single");
  const [additionalFlatTaxRatePct, setAdditionalFlatTaxRatePct] = useState(0);

  const [homeValue, setHomeValue] = useState("");
  const [homeGrowthRatePct, setHomeGrowthRatePct] = useState("0.03");
  const [hasMortgage, setHasMortgage] = useState(false);
  const [mortgageBalance, setMortgageBalance] = useState("");
  const [mortgageRate, setMortgageRate] = useState("0.065");
  const [mortgageYearsLeft, setMortgageYearsLeft] = useState("25");

  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false);
  const [incomeDrawerOpen, setIncomeDrawerOpen] = useState(false);
  const [expenseDrawerOpen, setExpenseDrawerOpen] = useState(false);
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);

  if (!open) return null;

  const resetLocalState = () => {
    setStep("welcome");
    setScenarioId(null);
    setSelfPersonId(null);
    setRetirementIndex(0);
    setError(null);
    setPlanName("My Plan");
    setSelfName("");
    setSelfBirthDate(defaultBirthDate());
    setNewName("");
    setNewBirthDate(defaultBirthDate());
    setStartDate(todayISO());
    setInflationRatePct(0.03);
    setFilingStatus("single");
    setAdditionalFlatTaxRatePct(0);
    setHomeValue("");
    setHomeGrowthRatePct("0.03");
    setHasMortgage(false);
    setMortgageBalance("");
    setMortgageRate("0.065");
    setMortgageYearsLeft("25");
  };

  const handleClose = () => {
    resetLocalState();
    onClose();
  };

  const handleStart = () => {
    const id = addBlankScenario(planName.trim() || "My Plan");
    setScenarioId(id);
    const created = usePlanStore.getState().plan.scenarios.find((s) => s.id === id);
    const person = created?.household.people[0];
    if (person) {
      setSelfPersonId(person.id);
      setSelfBirthDate(person.birthDate);
    }
    setError(null);
    setStep("person-self");
  };

  const handleSelfContinue = () => {
    if (!selfPersonId) return;
    if (!selfName.trim() || !selfBirthDate) {
      setError("Enter your name and date of birth to continue.");
      return;
    }
    const candidate = { name: selfName.trim(), birthDate: selfBirthDate, retirementAge: 65, planningEndAge: 95 };
    const result = personSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "That doesn't look right.");
      return;
    }
    updatePerson(selfPersonId, result.data);
    setError(null);
    setStep("person-more");
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
    setError(null);
    setStep("person-more");
  };

  const people = scenario?.household.people ?? [];
  const currentPerson: Person | undefined = people[retirementIndex];

  const handleRetirementContinue = () => {
    if (retirementIndex + 1 < people.length) {
      setRetirementIndex(retirementIndex + 1);
      return;
    }
    setFilingStatus(people.length > 1 ? "marriedFilingJointly" : "single");
    setStep("assumptions");
  };

  const handleAssumptionsContinue = () => {
    if (!scenario) return;
    const horizonYear = Math.max(
      ...scenario.household.people.map((p) => Number(p.birthDate.slice(0, 4)) + p.planningEndAge)
    );
    const candidate = {
      ...scenario.settings,
      startDate,
      horizonEndDate: `${horizonYear}-12-31`,
      inflationRatePct: Number(inflationRatePct) || 0,
      filingStatus,
      additionalFlatTaxRatePct: Number(additionalFlatTaxRatePct) || 0,
    };
    const result = forecastSettingsSchema.safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "That doesn't look right.");
      return;
    }
    updateSettings(result.data);
    setError(null);
    setStep("accounts");
  };

  const handleAddHome = () => {
    if (!scenario || !scenarioId) return;
    const result = addExistingHome(
      // The wizard keeps onboarding lean (no tax/insurance/maintenance/extra-
      // principal inputs here) -- those can be added via the Accounts tab's
      // "Add a Home You Already Own" any time after setup.
      { ...EXISTING_HOME_DEFAULTS, homeValue, homeGrowthRatePct, hasMortgage, mortgageBalance, mortgageRate, mortgageYearsLeft },
      scenario.settings.startDate
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setHomeValue("");
    setMortgageBalance("");
    setHasMortgage(false);
    setError(null);
    setStep("accounts");
  };

  const sectionIndex = SECTIONS.findIndex((sec) => sec.steps.includes(step));
  const nonHubAccounts = scenario?.accounts.filter((a) => !a.isExtraSavings) ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-y-auto rounded-lg border border-border bg-panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-dim">
              Step {sectionIndex + 1} of {SECTIONS.length} · {SECTIONS[sectionIndex]?.label}
            </div>
            <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-background">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${((sectionIndex + 1) / SECTIONS.length) * 100}%` }}
              />
            </div>
          </div>
          <button type="button" onClick={handleClose} className="rounded-md px-2 py-1 text-dim hover:bg-background hover:text-foreground">
            ✕
          </button>
        </div>

        <ErrorBanner message={error} />

        <div className="flex flex-col gap-4">
          {step === "welcome" && (
            <>
              <h2 className="text-lg font-semibold">Let&rsquo;s set up your plan</h2>
              <p className="text-sm text-dim">
                I&rsquo;ll ask a few questions about your household, accounts, income, and expenses to get your
                forecast started. Nothing here is permanent — everything can be changed later, and you can close
                this at any point and pick up where you left off from the app itself.
              </p>
              <Field label="What should we call this plan?">
                <input className={inputClass} value={planName} onChange={(e) => setPlanName(e.target.value)} />
              </Field>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={handleStart} className={primaryButtonClass}>
                  Let&rsquo;s get started →
                </button>
              </div>
            </>
          )}

          {step === "person-self" && (
            <>
              <h2 className="text-lg font-semibold">About you</h2>
              <p className="text-sm text-dim">
                Let&rsquo;s start with the basics — what&rsquo;s your name, and when were you born? Age drives
                retirement math and required withdrawals later in the plan.
              </p>
              <Field label="Your name">
                <input className={inputClass} value={selfName} onChange={(e) => setSelfName(e.target.value)} placeholder="e.g. Alex" />
              </Field>
              <Field label="Date of birth">
                <input className={inputClass} type="date" value={selfBirthDate} onChange={(e) => setSelfBirthDate(e.target.value)} />
              </Field>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={handleSelfContinue} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "person-more" && (
            <>
              <h2 className="text-lg font-semibold">
                {people.length > 1 ? "Anyone else to add?" : "Anyone else in this plan?"}
              </h2>
              <p className="text-sm text-dim">
                {people.length > 1
                  ? "You can add as many people as apply — or continue once everyone's in."
                  : "Is this plan just for you, or is someone else’s money part of it too — a spouse, partner, or anyone else you manage finances jointly with?"}
              </p>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => setStep("person-add")} className={optionButtonClass}>
                  {people.length > 1 ? "Yes, add another person" : "Yes, add someone else"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRetirementIndex(0);
                    setStep("retirement");
                  }}
                  className={optionButtonClass}
                >
                  {people.length > 1 ? "No, that's everyone" : "No, just me"}
                </button>
              </div>
              {people.length > 1 && (
                <p className="text-xs text-dim">So far: {people.map((p) => p.name).join(", ")}</p>
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
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setStep("person-more")} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" onClick={handleAddPerson} className={primaryButtonClass}>
                  Add
                </button>
              </div>
            </>
          )}

          {step === "retirement" && currentPerson && (
            <>
              <h2 className="text-lg font-semibold">Retirement — {currentPerson.name || "this person"}</h2>
              <Field label="At what age would they like to retire?" hint="If you're not sure, 65 is a common starting point.">
                <input
                  className={inputClass}
                  type="number"
                  value={currentPerson.retirementAge}
                  onChange={(e) =>
                    updatePerson(currentPerson.id, { ...currentPerson, retirementAge: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Field
                label="Plan through what age?"
                hint="Most people use 90-95 so the plan doesn't run out of runway before they do."
              >
                <input
                  className={inputClass}
                  type="number"
                  value={currentPerson.planningEndAge}
                  onChange={(e) =>
                    updatePerson(currentPerson.id, { ...currentPerson, planningEndAge: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={handleRetirementContinue} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "assumptions" && (
            <>
              <h2 className="text-lg font-semibold">A few money assumptions</h2>
              <p className="text-sm text-dim">These have sensible defaults — feel free to just continue.</p>
              <Field label="Plan start date">
                <input className={inputClass} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Inflation rate (e.g. 0.03 for 3%)">
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  value={inflationRatePct}
                  onChange={(e) => setInflationRatePct(Number(e.target.value))}
                />
              </Field>
              <Field label="Filing status">
                <select className={inputClass} value={filingStatus} onChange={(e) => setFilingStatus(e.target.value as FilingStatus)}>
                  <option value="single">Single</option>
                  <option value="marriedFilingJointly">Married filing jointly</option>
                </select>
              </Field>
              <Field
                label="Extra flat tax rate (optional)"
                hint="State or local income tax, as a flat add-on. Leave at 0 if unsure — you can add this later."
              >
                <input
                  className={inputClass}
                  type="number"
                  step="0.01"
                  value={additionalFlatTaxRatePct}
                  onChange={(e) => setAdditionalFlatTaxRatePct(Number(e.target.value))}
                />
              </Field>
              <p className="text-xs text-dim">
                Retirement accounts usually have required withdrawals after a certain age — that&rsquo;s handled
                automatically and can be changed later from Assumptions.
              </p>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={handleAssumptionsContinue} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "accounts" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Accounts</h2>
              <p className="text-sm text-dim">
                Let&rsquo;s add your accounts — bank accounts, investments, retirement accounts, and any debts like
                credit cards or loans. Add as many as apply, one at a time.
              </p>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => setAccountDrawerOpen(true)} className={optionButtonClass}>
                  + Add a bank, investment, retirement, or debt account
                </button>
                <button type="button" onClick={() => setStep("home-owned")} className={optionButtonClass}>
                  + Add a home you already own
                </button>
              </div>
              {nonHubAccounts.length > 0 ? (
                <p className="text-xs text-dim">Added so far: {nonHubAccounts.map((a) => a.name).join(", ")}</p>
              ) : (
                <p className="text-xs text-dim">Add at least one account to continue — a forecast needs somewhere to start from.</p>
              )}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep("income")}
                  disabled={nonHubAccounts.length === 0}
                  className={primaryButtonClass}
                >
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "home-owned" && (
            <>
              <h2 className="text-lg font-semibold">A home you already own</h2>
              <p className="text-xs text-dim">
                Buying a home in the future? That&rsquo;s handled later, under Life Events — this is only for a home
                you own today.
              </p>
              <Field label="Current estimated value">
                <input className={inputClass} type="number" step="0.01" value={homeValue} onChange={(e) => setHomeValue(e.target.value)} />
              </Field>
              <Field label="Annual appreciation rate (e.g. 0.03 for 3%)">
                <input
                  className={inputClass}
                  type="number"
                  step="0.001"
                  value={homeGrowthRatePct}
                  onChange={(e) => setHomeGrowthRatePct(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" className="h-4 w-4" checked={hasMortgage} onChange={(e) => setHasMortgage(e.target.checked)} />
                Still have a mortgage on it
              </label>
              {hasMortgage && (
                <div className="flex flex-col gap-3 border-l border-border pl-3">
                  <Field label="Remaining balance">
                    <input
                      className={inputClass}
                      type="number"
                      step="0.01"
                      value={mortgageBalance}
                      onChange={(e) => setMortgageBalance(e.target.value)}
                    />
                  </Field>
                  <Field label="Interest rate (e.g. 0.065 for 6.5%)">
                    <input
                      className={inputClass}
                      type="number"
                      step="0.001"
                      value={mortgageRate}
                      onChange={(e) => setMortgageRate(e.target.value)}
                    />
                  </Field>
                  <Field label="Years remaining">
                    <input
                      className={inputClass}
                      type="number"
                      step="1"
                      value={mortgageYearsLeft}
                      onChange={(e) => setMortgageYearsLeft(e.target.value)}
                    />
                  </Field>
                </div>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setStep("accounts")} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" onClick={handleAddHome} className={primaryButtonClass}>
                  Add home
                </button>
              </div>
            </>
          )}

          {step === "income" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Income</h2>
              <p className="text-sm text-dim">
                Now let&rsquo;s cover income — salary, Social Security, pensions, rental income, anything regular.
              </p>
              <button type="button" onClick={() => setIncomeDrawerOpen(true)} className={optionButtonClass}>
                + Add income
              </button>
              {scenario.incomeSources.length > 0 && (
                <p className="text-xs text-dim">Added so far: {scenario.incomeSources.map((i) => i.name).join(", ")}</p>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setStep("expenses")} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "expenses" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Expenses</h2>
              <p className="text-sm text-dim">
                Let&rsquo;s cover regular expenses — housing, transportation, food, healthcare, childcare, or
                anything else recurring.
              </p>
              <button type="button" onClick={() => setExpenseDrawerOpen(true)} className={optionButtonClass}>
                + Add expense
              </button>
              {scenario.expenses.length > 0 && (
                <p className="text-xs text-dim">Added so far: {scenario.expenses.map((e) => e.name).join(", ")}</p>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setStep("routing")} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "routing" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Where money goes</h2>
              {nonHubAccounts.length === 0 ? (
                <p className="text-sm text-dim">
                  You haven&rsquo;t added any accounts yet, so there&rsquo;s nothing to route between — you can set
                  this up later from the Routing tab once you&rsquo;ve added accounts.
                </p>
              ) : (
                <>
                  <p className="text-sm text-dim">
                    When you end up with extra money, where should it go first? And if expenses ever outpace income,
                    which account should cover the gap?
                  </p>
                  <MoneyFlowEditor accounts={scenario.accounts} settings={scenario.settings} />
                </>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setStep("events")} className={primaryButtonClass}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {step === "events" && scenario && (
            <>
              <h2 className="text-lg font-semibold">Life events</h2>
              <p className="text-sm text-dim">
                Last part — anything specific coming up you want the plan to account for? Retiring earlier than
                planned, buying a home, having a child, or a one-time transfer between accounts. Totally optional.
              </p>
              <button type="button" onClick={() => setEventDrawerOpen(true)} className={optionButtonClass}>
                + Add a life event
              </button>
              {scenario.events.length > 0 && (
                <p className="text-xs text-dim">Added so far: {scenario.events.map((e) => e.name).join(", ")}</p>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setStep("review")} className={primaryButtonClass}>
                  Finish setup →
                </button>
              </div>
            </>
          )}

          {step === "review" && scenario && (
            <>
              <h2 className="text-lg font-semibold">You&rsquo;re all set</h2>
              <p className="text-sm text-dim">Here&rsquo;s what&rsquo;s in &ldquo;{scenario.name}&rdquo; so far:</p>
              <ul className="list-inside list-disc text-sm text-foreground">
                <li>{scenario.household.people.length} {scenario.household.people.length === 1 ? "person" : "people"}</li>
                <li>{nonHubAccounts.length} account{nonHubAccounts.length === 1 ? "" : "s"}</li>
                <li>{scenario.incomeSources.length} income source{scenario.incomeSources.length === 1 ? "" : "s"}</li>
                <li>{scenario.expenses.length} expense{scenario.expenses.length === 1 ? "" : "s"}</li>
                <li>{scenario.events.length} life event{scenario.events.length === 1 ? "" : "s"}</li>
              </ul>
              <p className="text-sm text-dim">
                Everything here can be changed any time. If you want to try a different assumption later — like
                retiring two years earlier — duplicate this plan from the scenario tabs and adjust the copy, so you
                can compare them side by side.
              </p>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={handleClose} className={primaryButtonClass}>
                  Take me to my forecast
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {scenario && (
        <>
          <AccountDrawer
            open={accountDrawerOpen}
            onClose={() => setAccountDrawerOpen(false)}
            people={scenario.household.people}
          />
          <IncomeDrawer
            open={incomeDrawerOpen}
            onClose={() => setIncomeDrawerOpen(false)}
            people={scenario.household.people}
            accounts={scenario.accounts}
          />
          <ExpenseDrawer open={expenseDrawerOpen} onClose={() => setExpenseDrawerOpen(false)} accounts={scenario.accounts} />
          <EventDrawer
            open={eventDrawerOpen}
            onClose={() => setEventDrawerOpen(false)}
            accounts={scenario.accounts}
            people={scenario.household.people}
          />
        </>
      )}
    </div>
  );
}
