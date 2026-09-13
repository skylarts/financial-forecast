import { retirementsInOrder } from "@/domain";
import type { Scenario } from "@/domain";
import { addMonths, yearOf } from "./dateMath";
import type { ProjectionOptions } from "./forecastScenario";

/**
 * Deterministic stress tests: the same plan run under one bad assumption at a
 * time. Each preset is a transform of the scenario plus engine options; the
 * projection itself is unchanged, so a stressed run is exactly comparable to
 * the base run.
 *
 * Every preset here is a hazard of retiring in any decade -- returns, a bad
 * first year, inflation, longevity. Anything keyed to one policy's current
 * projection (a benefit cut in a named year, say) goes stale as soon as that
 * projection is revised, and belongs in the plan as an adjustment on the
 * income it affects, not in this list.
 */

export type StressKey = "lower_returns" | "bear_at_retirement" | "higher_inflation" | "live_longer" | "all_at_once";

export interface StressParams {
  /** Added to every investment account's yearly return, e.g. -0.02. */
  returnDelta: number;
  /** The investment return in the retirement year, e.g. -0.3. */
  crashReturn: number;
  /** Added to the inflation rate, e.g. 0.01. */
  inflationDelta: number;
  /** Years added to everyone's planning end age. */
  extraYears: number;
}

export const DEFAULT_STRESS_PARAMS: StressParams = {
  returnDelta: -0.02,
  crashReturn: -0.3,
  inflationDelta: 0.01,
  extraYears: 5,
};

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const pts = (x: number) => `${Math.abs(x * 100).toFixed(x * 100 % 1 === 0 ? 0 : 1)} point${Math.abs(x * 100) === 1 ? "" : "s"}`;

export const STRESS_PRESETS: { key: StressKey; label: string; describe: (p: StressParams, retirementYear: number | null) => string }[] = [
  {
    key: "lower_returns",
    label: "Lower returns",
    describe: (p) => `Every investment account earns ${pts(p.returnDelta)} ${p.returnDelta < 0 ? "less" : "more"} a year, for the whole plan.`,
  },
  {
    key: "bear_at_retirement",
    label: "Bear market at retirement",
    describe: (p, y) => `Investments fall ${pct(p.crashReturn)} in ${y ?? "the first year"}, then earn their normal return. No rebound is assumed.`,
  },
  {
    key: "higher_inflation",
    label: "Higher inflation",
    describe: (p) => `Inflation runs ${pts(p.inflationDelta)} higher for the whole plan: expenses and benefits rise faster, and fixed returns buy less.`,
  },
  {
    key: "live_longer",
    label: "Live longer",
    describe: (p) => `Everyone lives ${p.extraYears} years past their planning end age.`,
  },
  {
    key: "all_at_once",
    label: "All at once",
    describe: () => "Lower returns, the bear market, and higher inflation together.",
  },
];

/** The calendar year the first person in the household retires, or null when nobody does. */
export function retirementYearOf(scenario: Scenario): number | null {
  const first = retirementsInOrder(scenario.household.people)[0];
  return first ? yearOf(first.date) : null;
}

function liveLonger(scenario: Scenario, p: StressParams): Scenario {
  return {
    ...scenario,
    household: { people: scenario.household.people.map((person) => ({ ...person, planningEndAge: person.planningEndAge + p.extraYears })) },
    settings: { ...scenario.settings, horizonEndDate: addMonths(scenario.settings.horizonEndDate, p.extraYears * 12) },
  };
}

/** The scenario and engine options a stress preset runs with. */
export function applyStress(scenario: Scenario, key: StressKey, params: StressParams = DEFAULT_STRESS_PARAMS): { scenario: Scenario; options: ProjectionOptions } {
  const crashYear = retirementYearOf(scenario) ?? yearOf(scenario.settings.startDate ?? new Date().toISOString().slice(0, 10));
  switch (key) {
    case "lower_returns":
      return { scenario, options: { returnAdjustment: params.returnDelta } };
    case "bear_at_retirement":
      return { scenario, options: { yearReturnOverride: { year: crashYear, ratePct: params.crashReturn } } };
    case "higher_inflation":
      return { scenario: { ...scenario, settings: { ...scenario.settings, inflationRatePct: scenario.settings.inflationRatePct + params.inflationDelta } }, options: {} };
    case "live_longer":
      return { scenario: liveLonger(scenario, params), options: {} };
    case "all_at_once":
      return {
        scenario: { ...scenario, settings: { ...scenario.settings, inflationRatePct: scenario.settings.inflationRatePct + params.inflationDelta } },
        options: { returnAdjustment: params.returnDelta, yearReturnOverride: { year: crashYear, ratePct: params.crashReturn } },
      };
  }
}
