import { resolveAnchoredDates, retirementDateOf, retirementsInOrder } from "@/domain";
import type { ExpenseBaseline, IncomeSource, Person, RecurrenceFrequency, Scenario } from "@/domain";
import { addDays, addMonths, birthdayAtAge, compareDates, todayISO, yearOf } from "./dateMath";
import { INVESTMENT_CLASSES, type ProjectionOptions } from "./forecastScenario";
import { HISTORICAL_ERAS, HISTORICAL_ERA_YEARS, marketWindow, realBlendedReturn } from "./historicalReturns";

/**
 * Deterministic stress tests: the same plan run under one bad assumption at a
 * time. Each preset is a transform of the scenario plus engine options; the
 * projection itself is unchanged, so a stressed run is exactly comparable to
 * the base run.
 *
 * Every preset here is a hazard of retiring in any decade -- returns, a bad
 * stretch of years, inflation, longevity, a spouse's early death, a nursing
 * home, spending that runs over. Anything keyed to one policy's current
 * projection (a benefit cut in a named year, say) goes stale as soon as that
 * projection is revised, and belongs in the plan as an adjustment on the
 * income it affects, not in this list; the benefit haircut below is a
 * generic "what if it pays X% less", not a date.
 *
 * Nearly every preset is a scenario transform rather than an engine knob:
 * spending overrun scales the expenses, higher taxes raise the flat add-on
 * rate, a long-term care stay is an expense injected at an age. The engine
 * only needed to learn one thing for all of this -- a per-year return map --
 * which powers the multi-year bear, the historical replays and Monte Carlo.
 */

export type StressGroup = "markets" | "life" | "costs";

export type HistoryKey = `history_${number}`;

export type StressKey =
  | "lower_returns"
  | "bear_at_retirement"
  | "long_bear"
  | "higher_inflation"
  | "all_at_once"
  | HistoryKey
  | "live_longer"
  | "spouse_dies_early"
  | "long_term_care"
  | "forced_early_exit"
  | "spending_overrun"
  | "healthcare_blowup"
  | "higher_taxes"
  | "benefit_haircut"
  | "pension_no_cola";

export interface StressParams {
  /** Added to every investment account's yearly return, e.g. -0.02. */
  returnDelta: number;
  /** The investment return in the retirement year, e.g. -0.3. */
  crashReturn: number;
  /** Added to the inflation rate, e.g. 0.01. */
  inflationDelta: number;
  /** Years added to everyone's planning end age. */
  extraYears: number;
  /** The long bear: how many consecutive years the market falls. */
  bearYears: number;
  /** The long bear: the total fall across those years, e.g. -0.4. */
  bearTotalDrop: number;
  /** Years after retirement the bear (or a historical replay) begins: 0 = the retirement year. */
  sequenceOffsetYears: number;
  /** Historical replays: the share of the portfolio in stocks, the rest in bonds. */
  equityShare: number;
  /** Spending overrun: every entered expense runs this much higher, e.g. 0.15. */
  spendingOverrunPct: number;
  /** Higher taxes: added to the flat tax rate on retirement income, e.g. 0.03. */
  taxDeltaPct: number;
  /** Benefit haircut: Social Security pays this much less, e.g. 0.2. */
  benefitCutPct: number;
  /** Healthcare blowup: added to healthcare cost growth, e.g. 0.03. */
  healthcareExtraGrowthPct: number;
  /** Long-term care: monthly cost in today's dollars. */
  ltcMonthly: number;
  /** Long-term care: years of care. */
  ltcYears: number;
  /** Long-term care: the age care begins. */
  ltcStartAge: number;
  /** Spouse dies early: the age the household's larger earner is modelled as dying. */
  earlyDeathAge: number;
  /** Forced early exit: years everyone stops working before they planned to. */
  earlyExitYears: number;
}

export const DEFAULT_STRESS_PARAMS: StressParams = {
  returnDelta: -0.02,
  crashReturn: -0.3,
  inflationDelta: 0.01,
  extraYears: 5,
  bearYears: 3,
  bearTotalDrop: -0.4,
  sequenceOffsetYears: 0,
  equityShare: 0.6,
  spendingOverrunPct: 0.15,
  taxDeltaPct: 0.03,
  benefitCutPct: 0.2,
  healthcareExtraGrowthPct: 0.03,
  ltcMonthly: 9_000,
  ltcYears: 3,
  ltcStartAge: 82,
  earlyDeathAge: 70,
  earlyExitYears: 2,
};

/** The scenario and engine options one stress preset runs with. */
export interface StressRun {
  scenario: Scenario;
  options: ProjectionOptions;
}

/**
 * The one number a preset turns, for the breaking-point search: the plan is
 * expected to hold at `from` (the harmless end) and the search walks toward
 * `to` (the harshest value worth asking about) for the first value it fails
 * at. `format` words a value in the answer ("3.4 points", "$14,000/mo").
 */
export interface StressLever {
  param: keyof StressParams;
  from: number;
  to: number;
  /** Round a searched value to what a person would type. */
  round: (v: number) => number;
  format: (v: number) => string;
}

export interface StressPreset {
  key: StressKey;
  label: string;
  group: StressGroup;
  /** False when the plan has nothing for this test to act on (no pension, the healthcare model off, one person). */
  applies: (scenario: Scenario) => boolean;
  describe: (params: StressParams, scenario: Scenario) => string;
  apply: (scenario: Scenario, params: StressParams) => StressRun;
  lever?: StressLever;
}

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const pts = (x: number) => {
  const n = Math.abs(x * 100);
  return `${n.toFixed(n % 1 === 0 ? 0 : 1)} point${n === 1 ? "" : "s"}`;
};
const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const years = (n: number) => `${n} year${n === 1 ? "" : "s"}`;
const round1pt = (v: number) => Math.round(v * 1000) / 1000;
const roundPct = (v: number) => Math.round(v * 100) / 100;

/** The calendar year the first person in the household retires, or null when nobody does. */
export function retirementYearOf(scenario: Scenario): number | null {
  const first = retirementsInOrder(scenario.household.people)[0];
  return first ? yearOf(first.date) : null;
}

const planStartDate = (scenario: Scenario) => scenario.settings.startDate ?? todayISO();

/** The year a sequence-of-returns shock begins: the retirement year plus the offset, never before the plan starts. */
function sequenceStartYear(scenario: Scenario, params: StressParams): number {
  const startYear = yearOf(planStartDate(scenario));
  const anchor = retirementYearOf(scenario) ?? startYear;
  return Math.max(startYear, anchor + Math.max(0, Math.round(params.sequenceOffsetYears)));
}

/**
 * The plan's expected investment return: the plan-wide rate when set,
 * otherwise the balance-weighted average of the investment accounts' own
 * rates. What the non-stock share of a historical replay earns, and the
 * centre of a Monte Carlo distribution.
 */
export function expectedReturnOf(scenario: Scenario): number {
  const s = scenario.settings;
  if (s.planReturnRatePct != null) return s.planReturnRatePct;
  const investments = scenario.accounts.filter((a) => a.category === "asset" && !a.isExcluded && INVESTMENT_CLASSES.has(a.class));
  if (investments.length === 0) return s.inflationRatePct + 0.04;
  const rateOf = (a: (typeof investments)[number]) => a.growthRatePct ?? s.inflationRatePct;
  const weight = investments.reduce((sum, a) => sum + Math.max(0, a.startingBalance), 0);
  if (weight <= 0) return investments.reduce((sum, a) => sum + rateOf(a), 0) / investments.length;
  return investments.reduce((sum, a) => sum + rateOf(a) * Math.max(0, a.startingBalance), 0) / weight;
}

const ANNUAL_OCCURRENCES: Record<RecurrenceFrequency, number> = { monthly: 12, biweekly: 26, weekly: 52, annual: 1, one_time: 0 };

/** A rough yearly figure for an income source, for ranking who the household leans on. */
function yearlyAmount(src: IncomeSource): number {
  return src.amount * (src.intervalYears ? 1 / src.intervalYears : ANNUAL_OCCURRENCES[src.frequency]);
}

/** The household member whose income the plan leans on most -- whose early death hurts most. */
function largerEarner(scenario: Scenario): Person | null {
  const people = scenario.household.people;
  if (people.length < 2) return null;
  const incomeOf = (p: Person) => scenario.incomeSources.filter((s) => !s.isExcluded && s.ownerId === p.id).reduce((sum, s) => sum + yearlyAmount(s), 0);
  return people.reduce((best, p) => (incomeOf(p) > incomeOf(best) ? p : best), people[0]);
}

/** The oldest household member: the first to reach a long-term-care age. */
function oldestPerson(scenario: Scenario): Person {
  return scenario.household.people.reduce((oldest, p) => (compareDates(p.birthDate, oldest.birthDate) < 0 ? p : oldest), scenario.household.people[0]);
}

/** The plan horizon the household's planning end ages imply -- the same rule the setup wizard uses. */
function horizonFor(people: Person[]): string {
  const year = Math.max(...people.map((p) => yearOf(p.birthDate) + p.planningEndAge));
  return `${year}-12-31`;
}

function withInflationDelta(scenario: Scenario, delta: number): Scenario {
  return { ...scenario, settings: { ...scenario.settings, inflationRatePct: scenario.settings.inflationRatePct + delta } };
}

function liveLonger(scenario: Scenario, p: StressParams): Scenario {
  const extra = Math.max(0, Math.round(p.extraYears));
  return {
    ...scenario,
    household: { people: scenario.household.people.map((person) => ({ ...person, planningEndAge: person.planningEndAge + extra })) },
    settings: { ...scenario.settings, horizonEndDate: addMonths(scenario.settings.horizonEndDate, extra * 12) },
  };
}

/** A fall of `totalDrop` spread evenly over `years`: the same return each year that compounds to the total. */
function bearOverrides(scenario: Scenario, p: StressParams): Record<number, number> {
  const n = Math.max(1, Math.round(p.bearYears));
  const yearly = Math.pow(1 + Math.max(-0.999, p.bearTotalDrop), 1 / n) - 1;
  const start = sequenceStartYear(scenario, p);
  const out: Record<number, number> = {};
  for (let i = 0; i < n; i++) out[start + i] = yearly;
  return out;
}

/** Real historical returns for a blended portfolio, plus the plan's inflation, laid over the years from the sequence start. */
function historyOverrides(scenario: Scenario, p: StressParams, eraStartYear: number): Record<number, number> {
  const start = sequenceStartYear(scenario, p);
  const share = Math.min(1, Math.max(0, p.equityShare));
  const out: Record<number, number> = {};
  marketWindow(eraStartYear, HISTORICAL_ERA_YEARS).forEach((row, i) => {
    out[start + i] = realBlendedReturn(row, share) + scenario.settings.inflationRatePct;
  });
  return out;
}

function spouseDiesEarly(scenario: Scenario, p: StressParams): Scenario {
  const person = largerEarner(scenario);
  if (!person) return scenario;
  const age = Math.max(1, Math.round(p.earlyDeathAge));
  const people = scenario.household.people.map((x) => (x.id === person.id ? { ...x, planningEndAge: Math.min(x.planningEndAge, age) } : x));
  // The horizon follows the survivor: a plan that would otherwise keep
  // running for years after everyone in it has died says nothing useful.
  const horizon = horizonFor(people);
  const horizonEndDate = compareDates(horizon, scenario.settings.horizonEndDate) < 0 ? horizon : scenario.settings.horizonEndDate;
  return { ...scenario, household: { people }, settings: { ...scenario.settings, horizonEndDate } };
}

function longTermCare(scenario: Scenario, p: StressParams): Scenario {
  const person = oldestPerson(scenario);
  const careYears = Math.max(1, Math.round(p.ltcYears));
  // Care that would begin after the person's planning end age is pulled
  // back so it fits inside their life.
  const startAge = Math.min(Math.round(p.ltcStartAge), person.planningEndAge - careYears);
  const startDate = birthdayAtAge(person.birthDate, Math.max(0, startAge));
  const start = compareDates(startDate, planStartDate(scenario)) < 0 ? planStartDate(scenario) : startDate;
  const hc = scenario.settings.healthcare;
  const expense: ExpenseBaseline = {
    id: "stress:long_term_care",
    name: `Long-term care: ${person.name}`,
    amount: Math.max(0, p.ltcMonthly),
    frequency: "monthly",
    startDate: start,
    endDate: addDays(addMonths(start, careYears * 12), -1),
    // Medical costs outrun general inflation; follow the healthcare model's
    // growth when the plan has one, else the plan's inflation.
    growthRatePct: hc.enabled ? hc.costGrowthRatePct : null,
    paymentAccountId: null,
    category: "healthcare",
  };
  return { ...scenario, expenses: [...scenario.expenses, expense] };
}

function forcedEarlyExit(scenario: Scenario, p: StressParams): Scenario {
  const months = Math.max(0, Math.round(p.earlyExitYears * 12));
  const start = planStartDate(scenario);
  const people = scenario.household.people.map((person) => {
    const planned = retirementDateOf(person);
    if (!planned || compareDates(planned, start) <= 0) return person;
    const earlier = addMonths(planned, -months);
    return { ...person, retirementDate: compareDates(earlier, start) < 0 ? start : earlier };
  });
  // Anchored dates (a pension that starts at retirement, the healthcare
  // bridge) follow the moved retirement, exactly as they would in the editor.
  return resolveAnchoredDates({ ...scenario, household: { people } });
}

function spendingOverrun(scenario: Scenario, p: StressParams): Scenario {
  const factor = 1 + Math.max(-1, p.spendingOverrunPct);
  return {
    ...scenario,
    expenses: scenario.expenses.map((e) => ({ ...e, amount: e.amount * factor })),
    household: {
      people: scenario.household.people.map((person) =>
        person.retirementSpending ? { ...person, retirementSpending: { ...person.retirementSpending, amount: person.retirementSpending.amount * factor } } : person
      ),
    },
  };
}

function healthcareBlowup(scenario: Scenario, p: StressParams): Scenario {
  const hc = scenario.settings.healthcare;
  return {
    ...scenario,
    settings: {
      ...scenario.settings,
      healthcare: {
        ...hc,
        costGrowthRatePct: (hc.costGrowthRatePct ?? scenario.settings.inflationRatePct) + p.healthcareExtraGrowthPct,
        marketplace: { ...hc.marketplace, premiumTaxCredit: false },
      },
    },
  };
}

function higherTaxes(scenario: Scenario, p: StressParams): Scenario {
  const rate = Math.min(1, Math.max(0, scenario.settings.additionalFlatTaxRatePct + p.taxDeltaPct));
  return { ...scenario, settings: { ...scenario.settings, additionalFlatTaxRatePct: rate } };
}

function benefitHaircut(scenario: Scenario, p: StressParams): Scenario {
  const factor = 1 - Math.min(1, Math.max(0, p.benefitCutPct));
  return { ...scenario, incomeSources: scenario.incomeSources.map((s) => (s.category === "social_security" ? { ...s, amount: s.amount * factor } : s)) };
}

function pensionNoCola(scenario: Scenario): Scenario {
  return { ...scenario, incomeSources: scenario.incomeSources.map((s) => (s.category === "pension" ? { ...s, growthRatePct: 0 } : s)) };
}

const hasIncome = (scenario: Scenario, category: IncomeSource["category"]) => scenario.incomeSources.some((s) => s.category === category && !s.isExcluded);
const anyoneRetiresLater = (scenario: Scenario) =>
  scenario.household.people.some((person) => {
    const d = retirementDateOf(person);
    return d !== null && compareDates(d, planStartDate(scenario)) > 0;
  });

const always = () => true;
const startYearLabel = (scenario: Scenario, p: StressParams) => String(sequenceStartYear(scenario, p));

const MARKET_PRESETS: StressPreset[] = [
  {
    key: "lower_returns",
    label: "Lower returns",
    group: "markets",
    applies: always,
    describe: (p) => `Every investment account earns ${pts(p.returnDelta)} ${p.returnDelta < 0 ? "less" : "more"} a year, for the whole plan.`,
    apply: (scenario, p) => ({ scenario, options: { returnAdjustment: p.returnDelta } }),
    lever: { param: "returnDelta", from: 0, to: -0.15, round: round1pt, format: (v) => `${pts(v)} lower` },
  },
  {
    key: "bear_at_retirement",
    label: "Bear market at retirement",
    group: "markets",
    applies: always,
    describe: (p, s) => `Investments fall ${pct(p.crashReturn)} in ${startYearLabel(s, p)}, then earn their normal return. No rebound is assumed.`,
    apply: (scenario, p) => ({ scenario, options: { yearReturnOverride: { year: sequenceStartYear(scenario, p), ratePct: p.crashReturn } } }),
    lever: { param: "crashReturn", from: 0, to: -0.9, round: roundPct, format: (v) => `a ${pct(v)} fall` },
  },
  {
    key: "long_bear",
    label: "Long bear market",
    group: "markets",
    applies: always,
    describe: (p, s) =>
      `Investments fall ${pct(p.bearTotalDrop)} in total over ${years(Math.max(1, Math.round(p.bearYears)))} starting in ${startYearLabel(s, p)}, then earn their normal return. No rebound is assumed.`,
    apply: (scenario, p) => ({ scenario, options: { yearReturnOverrides: bearOverrides(scenario, p) } }),
    lever: { param: "bearTotalDrop", from: 0, to: -0.9, round: roundPct, format: (v) => `a ${pct(v)} total fall` },
  },
  {
    key: "higher_inflation",
    label: "Higher inflation",
    group: "markets",
    applies: always,
    describe: (p) => `Inflation runs ${pts(p.inflationDelta)} higher for the whole plan: expenses and benefits rise faster, and fixed returns buy less.`,
    apply: (scenario, p) => ({ scenario: withInflationDelta(scenario, p.inflationDelta), options: {} }),
    lever: { param: "inflationDelta", from: 0, to: 0.1, round: round1pt, format: (v) => `${pts(v)} higher` },
  },
  {
    key: "all_at_once",
    label: "Bad markets, all at once",
    group: "markets",
    applies: always,
    describe: () => "Lower returns, the bear market at retirement, and higher inflation together.",
    apply: (scenario, p) => ({
      scenario: withInflationDelta(scenario, p.inflationDelta),
      options: { returnAdjustment: p.returnDelta, yearReturnOverride: { year: sequenceStartYear(scenario, p), ratePct: p.crashReturn } },
    }),
  },
  ...HISTORICAL_ERAS.map<StressPreset>((era) => ({
    key: `history_${era.startYear}`,
    label: era.label,
    group: "markets",
    applies: always,
    describe: (p, s) => {
      const share = Math.round(Math.min(1, Math.max(0, p.equityShare)) * 100);
      const start = sequenceStartYear(s, p);
      return `Investments earn what a ${share}/${100 - share} stock/bond portfolio earned, after inflation, from ${era.startYear} to ${era.startYear + HISTORICAL_ERA_YEARS - 1} — laid over ${start} to ${start + HISTORICAL_ERA_YEARS - 1}. That era: ${era.summary}.`;
    },
    apply: (scenario, p) => ({ scenario, options: { yearReturnOverrides: historyOverrides(scenario, p, era.startYear) } }),
  })),
];

const LIFE_PRESETS: StressPreset[] = [
  {
    key: "live_longer",
    label: "Live longer",
    group: "life",
    applies: always,
    describe: (p) => `Everyone lives ${years(Math.max(0, Math.round(p.extraYears)))} past their planning end age.`,
    apply: (scenario, p) => ({ scenario: liveLonger(scenario, p), options: {} }),
    lever: { param: "extraYears", from: 0, to: 25, round: Math.round, format: (v) => `${years(Math.round(v))} longer` },
  },
  {
    key: "spouse_dies_early",
    label: "A spouse dies early",
    group: "life",
    applies: (s) => {
      const person = largerEarner(s);
      return person !== null && person.planningEndAge > DEFAULT_STRESS_PARAMS.earlyDeathAge;
    },
    describe: (p, s) => {
      const person = largerEarner(s);
      return `${person?.name ?? "The larger earner"} dies at ${Math.round(p.earlyDeathAge)}: their salary and Social Security stop (the survivor keeps the larger check), a pension continues only at its survivor share, and the survivor files single from the next year.`;
    },
    apply: (scenario, p) => ({ scenario: spouseDiesEarly(scenario, p), options: {} }),
  },
  {
    key: "long_term_care",
    label: "Long-term care",
    group: "life",
    applies: always,
    describe: (p, s) => {
      const person = oldestPerson(s);
      return `${person.name} needs ${years(Math.max(1, Math.round(p.ltcYears)))} of care at ${money(p.ltcMonthly)} a month (today's dollars) from age ${Math.round(p.ltcStartAge)}, on top of everything else.`;
    },
    apply: (scenario, p) => ({ scenario: longTermCare(scenario, p), options: {} }),
    lever: { param: "ltcMonthly", from: 0, to: 30_000, round: (v) => Math.round(v / 100) * 100, format: (v) => `${money(v)} a month` },
  },
  {
    key: "forced_early_exit",
    label: "Forced to stop working early",
    group: "life",
    applies: anyoneRetiresLater,
    describe: (p) => `Everyone still working retires ${years(Math.max(0, Math.round(p.earlyExitYears)))} earlier than planned: paychecks and contributions stop sooner, and anything tied to the retirement date moves with it.`,
    apply: (scenario, p) => ({ scenario: forcedEarlyExit(scenario, p), options: {} }),
    lever: { param: "earlyExitYears", from: 0, to: 10, round: Math.round, format: (v) => `${years(Math.round(v))} early` },
  },
];

const COST_PRESETS: StressPreset[] = [
  {
    key: "spending_overrun",
    label: "Spending runs over",
    group: "costs",
    applies: (s) => s.expenses.some((e) => !e.isExcluded) || s.household.people.some((p) => (p.retirementSpending?.amount ?? 0) > 0),
    describe: (p) => `Every expense you entered, and retirement spending, runs ${pct(p.spendingOverrunPct)} higher than planned for the whole plan.`,
    apply: (scenario, p) => ({ scenario: spendingOverrun(scenario, p), options: {} }),
    lever: { param: "spendingOverrunPct", from: 0, to: 1, round: roundPct, format: (v) => `${pct(v)} over` },
  },
  {
    key: "healthcare_blowup",
    label: "Healthcare costs blow up",
    group: "costs",
    applies: (s) => s.settings.healthcare.enabled,
    describe: (p) => `Healthcare costs grow ${pts(p.healthcareExtraGrowthPct)} a year faster, and the marketplace premium credit goes away.`,
    apply: (scenario, p) => ({ scenario: healthcareBlowup(scenario, p), options: {} }),
    lever: { param: "healthcareExtraGrowthPct", from: 0, to: 0.1, round: round1pt, format: (v) => `${pts(v)} faster` },
  },
  {
    key: "higher_taxes",
    label: "Higher taxes",
    group: "costs",
    applies: always,
    describe: (p) => `${pts(p.taxDeltaPct)} more tax on every dollar of retirement income: withdrawals, pension, taxable Social Security and gains.`,
    apply: (scenario, p) => ({ scenario: higherTaxes(scenario, p), options: {} }),
    lever: { param: "taxDeltaPct", from: 0, to: 0.25, round: round1pt, format: (v) => `${pts(v)} more` },
  },
  {
    key: "benefit_haircut",
    label: "Social Security pays less",
    group: "costs",
    applies: (s) => hasIncome(s, "social_security"),
    describe: (p) => `Every Social Security benefit pays ${pct(p.benefitCutPct)} less than entered, from the first check.`,
    apply: (scenario, p) => ({ scenario: benefitHaircut(scenario, p), options: {} }),
    lever: { param: "benefitCutPct", from: 0, to: 1, round: roundPct, format: (v) => `${pct(v)} less` },
  },
  {
    key: "pension_no_cola",
    label: "Pension never gets a raise",
    group: "costs",
    applies: (s) => s.incomeSources.some((src) => src.category === "pension" && !src.isExcluded && src.growthRatePct !== 0),
    describe: () => "Every pension is frozen at its starting amount for life: no cost-of-living raises, so inflation eats it a little more every year.",
    apply: (scenario) => ({ scenario: pensionNoCola(scenario), options: {} }),
  },
];

export const STRESS_PRESETS: readonly StressPreset[] = [...MARKET_PRESETS, ...LIFE_PRESETS, ...COST_PRESETS];

export const STRESS_GROUP_LABELS: Record<StressGroup, string> = {
  markets: "Markets",
  life: "Life",
  costs: "Costs and benefits",
};

export function stressPreset(key: StressKey): StressPreset | undefined {
  return STRESS_PRESETS.find((p) => p.key === key);
}

/** The presets that have something to act on in this plan, in display order. */
export function applicableStressPresets(scenario: Scenario): StressPreset[] {
  return STRESS_PRESETS.filter((p) => p.applies(scenario));
}

/** The scenario and engine options a stress preset runs with. */
export function applyStress(scenario: Scenario, key: StressKey, params: StressParams = DEFAULT_STRESS_PARAMS): StressRun {
  const preset = stressPreset(key);
  if (!preset) return { scenario, options: {} };
  return preset.apply(scenario, params);
}
