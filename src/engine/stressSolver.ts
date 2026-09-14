import { resolveAnchoredDates, retirementDateOf } from "@/domain";
import type { RecurrenceFrequency, Scenario } from "@/domain";
import { addMonths, compareDates, todayISO } from "./dateMath";
import type { ProjectionOptions } from "./forecastScenario";
import type { StressParams, StressPreset, StressRun } from "./stress";
import type { StressSummary } from "./stressSummary";

/**
 * The searches the stress tab runs on top of the presets: how much worse
 * a thing can get before the plan breaks, and the smallest single change
 * that mends a plan a preset has broken. Each is a bisection over one
 * number, on the assumption that turning it further only hurts -- true of
 * every lever the presets declare.
 *
 * Every projection goes through the `Runner` handed in, so the same code
 * runs synchronously in a test and through a worker pool in the app.
 */
export type Runner = (scenario: Scenario, options: ProjectionOptions) => Promise<StressSummary>;

const holds = (s: StressSummary) => s.firstShortfallYear === null;

/** How many halvings a search takes: 8 puts the answer within 1/256th of the range. */
export const SEARCH_STEPS = 8;

/**
 * Binary search for the largest `x` in [from, to] at which `probe(x)` still
 * holds, given it holds at `from` and fails at `to`. Returns the last value
 * seen to hold.
 */
async function largestHolding(from: number, to: number, probe: (x: number) => Promise<StressSummary>, steps: number): Promise<number> {
  let lo = from;
  let hi = to;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (holds(await probe(mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface BreakingPoint {
  /** `holds_all`: fine even at the harshest value searched. `already_short`: fails at the harmless end (the plan itself is short). `breaks`: the largest value that still holds. */
  kind: "holds_all" | "already_short" | "breaks";
  value: number;
  /** In words: "3.4 points lower", "holds even at 15 points lower". */
  label: string;
}

/** Where one preset's lever breaks the plan; null for a preset with no lever. */
export async function findBreakingPoint(scenario: Scenario, preset: StressPreset, params: StressParams, run: Runner, steps = SEARCH_STEPS): Promise<BreakingPoint | null> {
  const lever = preset.lever;
  if (!lever) return null;
  const probe = (x: number) => {
    const { scenario: s, options } = preset.apply(scenario, { ...params, [lever.param]: x });
    return run(s, options);
  };
  if (holds(await probe(lever.to))) return { kind: "holds_all", value: lever.to, label: `Holds even at ${lever.format(lever.to)}` };
  if (!holds(await probe(lever.from))) return { kind: "already_short", value: lever.from, label: "Already runs short" };
  const value = lever.round(await largestHolding(lever.from, lever.to, probe, steps));
  return { kind: "breaks", value, label: lever.format(value) };
}

export type FixKind = "spend_less" | "work_longer" | "save_more";

export interface Fix {
  kind: FixKind;
  /** The searched number: a spending fraction, months, or dollars. */
  value: number;
  /** In words: "Spend about $1,100 a month less", "Work 14 more months", "Have $85,000 more saved today". */
  label: string;
}

const MONTHLY_OCCURRENCES: Record<RecurrenceFrequency, number> = { monthly: 1, biweekly: 26 / 12, weekly: 52 / 12, annual: 1 / 12, one_time: 0 };

/** Today's-dollar monthly spending the plan entered: recurring expenses plus retirement spending, before any growth. */
export function enteredMonthlySpending(scenario: Scenario): number {
  const expenses = scenario.expenses
    .filter((e) => !e.isExcluded)
    .reduce((sum, e) => sum + e.amount * (e.intervalYears ? 1 / (12 * e.intervalYears) : MONTHLY_OCCURRENCES[e.frequency]), 0);
  const retirement = scenario.household.people.reduce((sum, p) => sum + (p.retirementSpending?.amount ?? 0) / 12, 0);
  return expenses + retirement;
}

/** Every entered expense and retirement spending scaled by `factor`. */
export function scaleSpending(scenario: Scenario, factor: number): Scenario {
  return {
    ...scenario,
    expenses: scenario.expenses.map((e) => ({ ...e, amount: e.amount * factor })),
    household: {
      people: scenario.household.people.map((p) => (p.retirementSpending ? { ...p, retirementSpending: { ...p.retirementSpending, amount: p.retirementSpending.amount * factor } } : p)),
    },
  };
}

/** Every retirement still ahead moved `months` later, with the dates anchored to it. */
export function shiftRetirements(scenario: Scenario, months: number): Scenario {
  const start = scenario.settings.startDate ?? todayISO();
  const people = scenario.household.people.map((person) => {
    const planned = retirementDateOf(person);
    if (!planned || compareDates(planned, start) <= 0) return person;
    return { ...person, retirementDate: addMonths(planned, months) };
  });
  return resolveAnchoredDates({ ...scenario, household: { people } });
}

/** `amount` more in the plan's largest investment account today (the spending hub when there is none). */
export function addSavings(scenario: Scenario, amount: number): Scenario {
  const candidates = scenario.accounts.filter((a) => a.category === "asset" && !a.isExcluded && a.class === "taxable_investment");
  const target = candidates.sort((a, b) => b.startingBalance - a.startingBalance)[0] ?? scenario.accounts.find((a) => a.isExtraSavings);
  if (!target) return scenario;
  return { ...scenario, accounts: scenario.accounts.map((a) => (a.id === target.id ? { ...a, startingBalance: a.startingBalance + amount } : a)) };
}

const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

const FIX_RANGES = {
  /** Up to half of entered spending. */
  spend_less: 0.5,
  /** Up to ten more years of work. */
  work_longer: 120,
  /** Up to five million more saved. */
  save_more: 5_000_000,
} as const;

/**
 * The smallest single change of each kind that lets `stressed` hold, for a
 * stressed run that does not. A kind the plan cannot use (nobody still
 * working) or that cannot mend it within range is left out.
 */
export async function findFixes(stressed: StressRun, run: Runner, steps = SEARCH_STEPS): Promise<Fix[]> {
  const { scenario, options } = stressed;
  const fixes: Fix[] = [];

  // Each search wants the SMALLEST mending value: probe with the change
  // reversed (largest value that still fails) and take the next step up.
  const smallestMending = async (max: number, apply: (x: number) => Scenario): Promise<number | null> => {
    if (!holds(await run(apply(max), options))) return null;
    let lo = 0;
    let hi = max;
    for (let i = 0; i < steps; i++) {
      const mid = (lo + hi) / 2;
      if (holds(await run(apply(mid), options))) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  const spendFraction = await smallestMending(FIX_RANGES.spend_less, (x) => scaleSpending(scenario, 1 - x));
  if (spendFraction !== null) {
    const monthly = enteredMonthlySpending(scenario) * spendFraction;
    const pct = Math.ceil(spendFraction * 100);
    fixes.push({ kind: "spend_less", value: spendFraction, label: `Spend about ${money(Math.ceil(monthly / 50) * 50)} a month less (${pct}% of what you entered)` });
  }

  const start = scenario.settings.startDate ?? todayISO();
  const anyoneStillWorking = scenario.household.people.some((p) => {
    const d = retirementDateOf(p);
    return d !== null && compareDates(d, start) > 0;
  });
  if (anyoneStillWorking) {
    const months = await smallestMending(FIX_RANGES.work_longer, (x) => shiftRetirements(scenario, Math.ceil(x)));
    if (months !== null) {
      const m = Math.ceil(months);
      const label = m >= 24 && m % 12 === 0 ? `${m / 12} more years` : m > 1 ? `${m} more months` : "one more month";
      fixes.push({ kind: "work_longer", value: m, label: `Work ${label}` });
    }
  }

  const savings = await smallestMending(FIX_RANGES.save_more, (x) => addSavings(scenario, x));
  if (savings !== null) {
    const rounded = Math.ceil(savings / 5_000) * 5_000;
    fixes.push({ kind: "save_more", value: rounded, label: `Have ${money(rounded)} more saved today` });
  }

  return fixes;
}
