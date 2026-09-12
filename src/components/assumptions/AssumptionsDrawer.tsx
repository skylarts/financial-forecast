"use client";

import { useMemo, useState } from "react";
import type { ForecastSettings, HealthcareSettings, Person, Scenario } from "@/domain";
import { personSchema, forecastSettingsSchema } from "@/domain";
import { addMonths, ageOn } from "@/engine/dateMath";
import { HEALTHCARE_TABLES_2026, isHealthcareItemId } from "@/engine/healthcare";
import { Drawer } from "@/components/ui/Drawer";
import { ErrorBanner, InfoTooltip, MoneyInput, PercentInput, inputClass } from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { formatMoney } from "@/lib/format";
import { usePlanStore } from "@/store/usePlanStore";
import { useProjection } from "@/store/useProjection";

/** The horizon year implied by the household's longest planning-end age. */
function horizonYearFromPeople(people: Person[]): number {
  return Math.max(...people.map((p) => Number(p.birthDate.slice(0, 4)) + p.planningEndAge));
}

function PersonRow({ person }: { person: Person }) {
  const updatePerson = usePlanStore((s) => s.updatePerson);
  const removePerson = usePlanStore((s) => s.removePerson);
  const [draft, setDraft] = useState(person);

  const save = () => {
    const result = personSchema.omit({ id: true }).safeParse(draft);
    if (!result.success) return;
    const retirementAgeChanged = result.data.retirementAge !== person.retirementAge;
    const planningEndChanged =
      result.data.planningEndAge !== person.planningEndAge || result.data.birthDate !== person.birthDate;
    updatePerson(person.id, result.data);

    // These two ages are only meaningful through what they derive -- keep the
    // derived things in sync so editing them here actually changes the plan:
    const { activeScenario, updateSettings, updateEvent } = usePlanStore.getState();
    const scenario = activeScenario();
    if (retirementAgeChanged) {
      // Move this person's Retire event(s) to their birthday at the new age.
      for (const e of scenario.events) {
        if (e.type !== "retire" || e.personId !== person.id) continue;
        const updated = {
          ...e,
          retirementAge: result.data.retirementAge,
          startDate: addMonths(result.data.birthDate, result.data.retirementAge * 12),
        };
        updateEvent(e.id, updated as Omit<typeof e, "id">);
      }
    }
    if (planningEndChanged) {
      // The horizon is derived from the longest planning-end age.
      const horizonYear = horizonYearFromPeople(scenario.household.people);
      updateSettings({ ...scenario.settings, horizonEndDate: `${horizonYear}-12-31` });
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
      <input
        className="col-span-2 rounded border border-border bg-background px-2 py-1 text-sm"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        onBlur={save}
        placeholder="Name"
      />
      <input
        className="rounded border border-border bg-background px-2 py-1 text-sm"
        type="date"
        value={draft.birthDate}
        onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
        onBlur={save}
      />
      <div />
      <label className="flex flex-col gap-1 text-xs text-dim">
        <span className="inline-flex items-center gap-1">
          Retirement age
          <InfoTooltip text="Changing this moves this person's Retire event (which is what actually stops their salary and contributions) to their birthday at the new age." />
        </span>
        <input
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          type="number"
          value={draft.retirementAge}
          onChange={(e) => setDraft({ ...draft, retirementAge: Number(e.target.value) })}
          onBlur={save}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-dim">
        <span className="inline-flex items-center gap-1">
          Planning end age
          <InfoTooltip text="The age this person is modelled as living to. It sets the forecast horizon (the longest in the household wins), and from that birthday their salary stops, a pension continues at its survivor share, the survivor keeps the larger Social Security check, and a married household files single the next year." />
        </span>
        <input
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          type="number"
          value={draft.planningEndAge}
          onChange={(e) => setDraft({ ...draft, planningEndAge: Number(e.target.value) })}
          onBlur={save}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          const removed = removePerson(person.id);
          if (!removed) {
            alert(
              `Can't remove ${person.name || "this person"} -- they're still the owner of an account or income source, or referenced by an event (e.g. Retire, Social Security). Update or delete those first.`
            );
          }
        }}
        className="col-span-2 rounded-md border border-negative/40 py-1 text-xs text-negative hover:bg-negative/10"
      >
        Remove {person.name || "person"}
      </button>
    </div>
  );
}

/**
 * A collapsible group of settings. Closed groups show a one-line summary so
 * the drawer reads as a table of contents rather than a wall of inputs.
 */
function Section({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-dim">{title}</span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-dim-2">
          {!open && summary && <span className="truncate">{summary}</span>}
          <span aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-border p-3">{children}</div>}
    </section>
  );
}

const fieldLabel = "flex flex-col gap-1 text-xs text-dim";

/** A percent field that commits when you leave it, re-seeded whenever the stored value changes elsewhere. */
function PctField({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number | null;
  placeholder?: string;
  onCommit: (fraction: number | null) => void;
}) {
  return (
    <label className={fieldLabel}>
      <span className="inline-flex items-center gap-1">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
      <PercentInput
        key={value ?? "blank"}
        defaultValue={fractionToPercentStr(value)}
        placeholder={placeholder}
        onBlur={(e) => onCommit(percentStrToFraction(e.target.value))}
      />
    </label>
  );
}

function MoneyField({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number | null;
  placeholder?: string;
  onCommit: (amount: number | null) => void;
}) {
  return (
    <label className={fieldLabel}>
      <span className="inline-flex items-center gap-1">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
      <MoneyInput
        key={value ?? "blank"}
        defaultValue={moneyToStr(value)}
        placeholder={placeholder}
        onBlur={(e) => onCommit(moneyStrToNumber(e.target.value))}
      />
    </label>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="inline-flex items-center gap-1">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-soft p-2.5">
      <div className="text-[11px] font-semibold text-dim">{title}</div>
      {children}
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  employer: "Employer plan",
  cobra: "COBRA",
  retiree: "Retiree plan",
  marketplace: "Marketplace",
  medicare: "Medicare",
};

export function AssumptionsDrawer({ open, onClose, scenario }: { open: boolean; onClose: () => void; scenario: Scenario }) {
  const addPerson = usePlanStore((s) => s.addPerson);
  const updateSettings = usePlanStore((s) => s.updateSettings);
  // Read live from the store and patch one field at a time. A local copy of
  // the settings taken when the drawer mounted used to be written back whole
  // on every edit, silently undoing changes made elsewhere (the Routing tab).
  const settings = usePlanStore((s) => s.activeScenario().settings);
  const people = usePlanStore((s) => s.activeScenario().household.people);
  const [error, setError] = useState<string | null>(null);
  const [newPersonName, setNewPersonName] = useState("");
  const projection = useProjection(scenario);

  const patch = (p: Partial<ForecastSettings>) => {
    const current = usePlanStore.getState().activeScenario().settings;
    const result = forecastSettingsSchema.safeParse({ ...current, ...p });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid settings.");
      return;
    }
    setError(null);
    updateSettings(result.data);
  };
  const patchHealthcare = (p: Partial<HealthcareSettings>) => {
    const current = usePlanStore.getState().activeScenario().settings.healthcare;
    patch({ healthcare: { ...current, ...p } });
  };
  const hc = settings.healthcare;
  const inflationLabel = fractionToPercentStr(settings.inflationRatePct) || "0";

  // Expenses the user entered by hand under "healthcare": once the model is
  // on, premiums entered that way would count twice.
  const manualHealthcareExpenses = scenario.expenses.filter((e) => e.category === "healthcare" && !e.isExcluded);

  // The years the coverage picture changes, with that year's cost in
  // today's dollars -- a quick read of what the model will charge.
  const healthcarePreview = useMemo(() => {
    if (!hc.enabled) return [];
    const rows: { year: number; ages: string; phase: string; perYear: number }[] = [];
    let prevSig: string | null = null;
    for (const y of projection.years) {
      const items = y.cashFlow.expenseByItem.filter((i) => isHealthcareItemId(i.id));
      const kinds = [...new Set(items.map((i) => i.id.split(":")[1]))].filter((k) => PHASE_LABELS[k]);
      const sig = kinds.sort().join("+");
      if (sig === prevSig) continue;
      prevSig = sig;
      const total = items.reduce((s, i) => s + i.amount, 0) / y.flowInflationDeflator;
      const ages = people.map((p) => ageOn(p.birthDate, `${y.year}-12-31`)).join(" / ");
      rows.push({ year: y.year, ages, phase: kinds.map((k) => PHASE_LABELS[k]).join(" + ") || "No premium (employer plan, or none)", perYear: total });
    }
    return rows;
  }, [hc.enabled, projection.years, people]);

  const returnSummary =
    settings.planReturnRatePct == null
      ? "Each account's own rate"
      : `${fractionToPercentStr(settings.planReturnRatePct)}% on every investment account`;
  const healthSummary = !hc.enabled
    ? "Off"
    : `${hc.retiredCoverage === "fixed" ? "Retiree plan" : hc.retiredCoverage === "none" ? "No coverage" : hc.retiredCoverage === "cobra_then_marketplace" ? "COBRA, then marketplace" : "Marketplace"} before 65, Medicare after`;

  return (
    <Drawer open={open} onClose={onClose} title="Assumptions">
      <div className="flex flex-col gap-3">
        <ErrorBanner message={error} />

        <Section title="Household" defaultOpen summary={people.map((p) => p.name).join(", ")}>
          {people.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="New person's name"
              value={newPersonName}
              onChange={(e) => setNewPersonName(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                if (!newPersonName.trim()) return;
                addPerson({ name: newPersonName.trim(), birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 });
                setNewPersonName("");
              }}
              className="rounded-md bg-pri px-3 py-1.5 text-sm font-semibold text-pri-fg"
            >
              Add
            </button>
          </div>
        </Section>

        <Section
          title="Plan"
          defaultOpen
          summary={`Inflation ${inflationLabel}% · ${settings.filingStatus === "single" ? "Single" : "Married filing jointly"}`}
        >
          <label className={fieldLabel}>
            <span className="inline-flex items-center gap-1">
              Start date
              <InfoTooltip text="Every account's balance is treated as being as of this date, and growth/contributions compound forward from here (accounts created by an event, like a home purchase, use that event's date instead). Leave this blank to always use today's date -- the plan then recalculates from 'now' every time you open it, so starting balances stay current without you needing to update this field. Set an explicit date only to override that (e.g. to backdate the plan, or model starting on a future date); if you do, remember that moving it without also updating each account's Starting Balance will make the projection skip or double-count time." />
            </span>
            <input
              className={inputClass}
              type="date"
              value={settings.startDate ?? ""}
              onChange={(e) => patch({ startDate: e.target.value || null })}
            />
            <span className="text-[11px] text-dim-2">
              {settings.startDate ? "Pinned to this date." : "Blank = today's date, updated automatically each time you open the plan."}
            </span>
          </label>
          <PctField
            label="Inflation rate (per year)"
            hint="Percent per year, e.g. 3 for 3%. Also the default growth rate for every input whose growth is left blank."
            value={settings.inflationRatePct}
            placeholder="e.g. 3"
            onCommit={(f) => {
              if (f !== null) patch({ inflationRatePct: f });
            }}
          />
          <Check
            label="Enable required minimum distributions (RMDs)"
            hint="Forced annual withdrawals from tax-deferred accounts flagged 'Subject to RMDs' -- starting at age 73, or 75 for anyone born 1960 or later (SECURE 2.0)."
            checked={settings.rmdEnabled}
            onChange={(on) => patch({ rmdEnabled: on })}
          />
          <Group title="Federal tax">
            <p className="text-[11px] text-dim-2">
              Computed each year from real IRS brackets on that year&rsquo;s realized income (withdrawals, taxable Social Security, pension, capital gains). See the Cash Flow tab.
            </p>
            <label className={fieldLabel}>
              Filing status
              <select
                className={inputClass}
                value={settings.filingStatus}
                onChange={(e) => patch({ filingStatus: e.target.value as ForecastSettings["filingStatus"] })}
              >
                <option value="marriedFilingJointly">Married filing jointly</option>
                <option value="single">Single</option>
              </select>
            </label>
            <PctField
              label="Additional flat tax rate"
              hint="State/local add-on to the computed federal tax, in percent (e.g. 5 for 5%). Leave at 0 if none -- correct as-is for a no-income-tax state."
              value={settings.additionalFlatTaxRatePct}
              placeholder="e.g. 5"
              onCommit={(f) => patch({ additionalFlatTaxRatePct: f ?? 0 })}
            />
          </Group>
          <label className={fieldLabel}>
            <span className="inline-flex items-center gap-1">
              Horizon end date
              <InfoTooltip text="Normally derived from the household's longest planning-end age -- editing a person's planning end age updates this automatically. Set it directly only to override that." />
            </span>
            <input className={inputClass} type="date" value={settings.horizonEndDate} onChange={(e) => patch({ horizonEndDate: e.target.value })} />
          </label>
        </Section>

        <Section title="Expected return" summary={returnSummary}>
          <Check
            label="Use one expected return for every investment account"
            hint="Applies to taxable, tax-deferred, Roth, HSA and 529 accounts. While it is on, each account's own growth rate and any scheduled changes are ignored; cash and real estate keep their own rates. Turn it off to go back to per-account rates."
            checked={settings.planReturnRatePct != null}
            onChange={(on) => patch({ planReturnRatePct: on ? 0.06 : null })}
          />
          {settings.planReturnRatePct != null ? (
            <PctField
              label="Expected return (per year, nominal)"
              hint="The rate you'd see reported, before inflation is taken out. A 60/40 portfolio has historically returned about 6-7% a year; use a lower figure to be conservative. The Stress test tab shows what a worse run looks like."
              value={settings.planReturnRatePct}
              placeholder="e.g. 6"
              onCommit={(f) => patch({ planReturnRatePct: f ?? 0 })}
            />
          ) : (
            <p className="text-[11px] text-dim-2">Each account uses the growth rate set on the account (blank = inflation).</p>
          )}
        </Section>

        <Section title="Healthcare" summary={healthSummary}>
          <Check
            label="Model healthcare costs"
            hint="Adds premiums and out-of-pocket costs for each person by stage: an employer plan while working, your choice of coverage before 65, and Medicare after. The marketplace premium credit and Medicare's income surcharges follow the plan's own income each year."
            checked={hc.enabled}
            onChange={(on) => patchHealthcare({ enabled: on })}
          />
          {hc.enabled && manualHealthcareExpenses.length > 0 && (
            <p className="rounded-md border border-gold/40 bg-gold/10 px-2.5 py-2 text-[11px] text-foreground">
              Also in the plan as healthcare expenses: {manualHealthcareExpenses.map((e) => e.name).join(", ")}. If those are premiums, exclude or delete them so they are not counted twice.
            </p>
          )}
          {hc.enabled && (
            <>
              <PctField
                label="Healthcare costs grow (per year)"
                hint={`Medical costs have outpaced general inflation for decades. Blank = the plan's inflation rate (${inflationLabel}%).`}
                value={hc.costGrowthRatePct}
                placeholder={`blank = inflation (${inflationLabel}%)`}
                onCommit={(f) => patchHealthcare({ costGrowthRatePct: f })}
              />
              <Group title="While someone is working">
                <MoneyField
                  label="Premium out of take-home, per person / month"
                  hint="Most people's share of an employer plan comes out of the paycheck before take-home pay, so it is already reflected in the salary you entered. Enter an amount only if you pay it separately."
                  value={hc.workingMonthlyPremiumPerPerson}
                  placeholder="0"
                  onCommit={(n) => patchHealthcare({ workingMonthlyPremiumPerPerson: n ?? 0 })}
                />
                <Check
                  label="A working spouse's plan covers the household"
                  hint="While anyone has a salary, everyone under 65 stays on the employer plan at the premium above, instead of buying coverage of their own."
                  checked={hc.spouseCoverageWhileWorking}
                  onChange={(on) => patchHealthcare({ spouseCoverageWhileWorking: on })}
                />
              </Group>
              <Group title="Before 65, once nobody is working">
                <label className={fieldLabel}>
                  Coverage
                  <select
                    className={inputClass}
                    value={hc.retiredCoverage}
                    onChange={(e) => patchHealthcare({ retiredCoverage: e.target.value as HealthcareSettings["retiredCoverage"] })}
                  >
                    <option value="marketplace">Marketplace plan (ACA exchange)</option>
                    <option value="cobra_then_marketplace">COBRA first, then a marketplace plan</option>
                    <option value="fixed">A retiree plan or other fixed premium</option>
                    <option value="none">No premium (covered some other way)</option>
                  </select>
                </label>
                {hc.retiredCoverage === "fixed" && (
                  <MoneyField
                    label="Premium per person / month"
                    hint="What each person pays for the plan today. Grows with healthcare costs."
                    value={hc.fixedMonthlyPremiumPerPerson}
                    onCommit={(n) => patchHealthcare({ fixedMonthlyPremiumPerPerson: n ?? 0 })}
                  />
                )}
                {hc.retiredCoverage === "cobra_then_marketplace" && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className={fieldLabel}>
                      COBRA months
                      <input
                        className={inputClass}
                        type="number"
                        min={0}
                        max={36}
                        key={hc.cobra.months}
                        defaultValue={hc.cobra.months}
                        onBlur={(e) => patchHealthcare({ cobra: { ...hc.cobra, months: Math.max(0, Math.round(Number(e.target.value) || 0)) } })}
                      />
                    </label>
                    <MoneyField
                      label="COBRA premium / person / month"
                      value={hc.cobra.monthlyPremiumPerPerson}
                      onCommit={(n) => patchHealthcare({ cobra: { ...hc.cobra, monthlyPremiumPerPerson: n ?? 0 } })}
                    />
                  </div>
                )}
                {(hc.retiredCoverage === "marketplace" || hc.retiredCoverage === "cobra_then_marketplace") && (
                  <>
                    <MoneyField
                      label="Benchmark plan, full price, per person / month"
                      hint="What the second-lowest-cost silver plan costs a person your age today, before any credit -- look it up on your state's exchange or healthcare.gov. Grows with healthcare costs, and with age if the box below is on."
                      value={hc.marketplace.benchmarkMonthlyPremiumPerPerson}
                      onCommit={(n) => patchHealthcare({ marketplace: { ...hc.marketplace, benchmarkMonthlyPremiumPerPerson: n ?? 0 } })}
                    />
                    <Check
                      label="Premium rises with age"
                      hint="Marketplace premiums follow a federal age curve: a 60-year-old pays about 2.1 times what a 40-year-old does, and 64 is three times 21. The premium above is scaled from each person's age today."
                      checked={hc.marketplace.ageRated}
                      onChange={(on) => patchHealthcare({ marketplace: { ...hc.marketplace, ageRated: on } })}
                    />
                    <Check
                      label="Apply the premium tax credit"
                      hint="With income between one and four times the poverty line, the household's cost is capped at 2-10% of income and the credit covers the rest. The plan's own income each year (withdrawals, conversions, pension, Social Security, gains) sets the credit -- so a large Roth conversion in a marketplace year costs a credit. Below the poverty line no credit applies (Medicaid may, depending on the state)."
                      checked={hc.marketplace.premiumTaxCredit}
                      onChange={(on) => patchHealthcare({ marketplace: { ...hc.marketplace, premiumTaxCredit: on } })}
                    />
                    {hc.marketplace.premiumTaxCredit && (
                      <Check
                        label="Assume the enhanced credits return"
                        hint="The 2021-2025 schedule: no income cap and an 8.5% ceiling. Off = the schedule in current law, with the cliff at four times the poverty line."
                        checked={hc.marketplace.enhancedSubsidies}
                        onChange={(on) => patchHealthcare({ marketplace: { ...hc.marketplace, enhancedSubsidies: on } })}
                      />
                    )}
                  </>
                )}
              </Group>
              <Group title="Medicare, from 65">
                <p className="text-[11px] text-dim-2">
                  Part B&rsquo;s standard premium (${HEALTHCARE_TABLES_2026.medicare.partBStandardMonthly.toFixed(2)}/month in 2026) is built in and grows with healthcare costs.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <MoneyField
                    label="Part D plan / month"
                    hint="The drug plan's own premium, before any income surcharge."
                    value={hc.medicare.partDMonthlyPremium}
                    onCommit={(n) => patchHealthcare({ medicare: { ...hc.medicare, partDMonthlyPremium: n ?? 0 } })}
                  />
                  <MoneyField
                    label="Medigap or Advantage / month"
                    hint="A supplement plan or Medicare Advantage premium, per person."
                    value={hc.medicare.supplementMonthlyPremium}
                    onCommit={(n) => patchHealthcare({ medicare: { ...hc.medicare, supplementMonthlyPremium: n ?? 0 } })}
                  />
                </div>
                <Check
                  label="Apply income surcharges (IRMAA)"
                  hint="Part B and Part D cost more when the household's income two years earlier was above about $109,000 (single) or $218,000 (joint). Large required distributions or Roth conversions in the RMD years land here."
                  checked={hc.medicare.irmaa}
                  onChange={(on) => patchHealthcare({ medicare: { ...hc.medicare, irmaa: on } })}
                />
              </Group>
              <Group title="Out of pocket">
                <div className="grid grid-cols-2 gap-2">
                  <MoneyField
                    label="Before 65, per person / year"
                    hint="Deductibles, copays, dental, vision."
                    value={hc.outOfPocket.preMedicareAnnualPerPerson}
                    onCommit={(n) => patchHealthcare({ outOfPocket: { ...hc.outOfPocket, preMedicareAnnualPerPerson: n ?? 0 } })}
                  />
                  <MoneyField
                    label="On Medicare, per person / year"
                    value={hc.outOfPocket.medicareAnnualPerPerson}
                    onCommit={(n) => patchHealthcare({ outOfPocket: { ...hc.outOfPocket, medicareAnnualPerPerson: n ?? 0 } })}
                  />
                </div>
                <Check
                  label="Pay from a health savings account while it lasts"
                  hint="Out-of-pocket costs come from an HSA in the plan first; once it is empty they come from cash like any other bill."
                  checked={hc.outOfPocket.payFromHsa}
                  onChange={(on) => patchHealthcare({ outOfPocket: { ...hc.outOfPocket, payFromHsa: on } })}
                />
              </Group>
              {healthcarePreview.length > 0 && (
                <Group title="What the model charges (today's dollars)">
                  <table className="w-full text-[11.5px]">
                    <tbody>
                      {healthcarePreview.map((r) => (
                        <tr key={r.year} className="border-t border-border-soft first:border-t-0">
                          <td className="py-1 pr-2 font-mono tabular-nums text-dim">{r.year}</td>
                          <td className="py-1 pr-2 text-dim-2">ages {r.ages}</td>
                          <td className="py-1 pr-2">{r.phase}</td>
                          <td className="py-1 text-right font-mono tabular-nums">{formatMoney(r.perYear)}/yr</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-dim-2">Each row is the first year of a new coverage picture. The Cash Flow tab lists every year.</p>
                </Group>
              )}
            </>
          )}
        </Section>

        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
          Close
        </button>
      </div>
    </Drawer>
  );
}
