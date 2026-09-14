import type { StressKey, StressParams } from "@/engine/stress";

/**
 * The one or two numbers each stress test turns, described for its own
 * row on the tab -- so a knob sits next to the test it changes instead of
 * in a separate panel the reader has to map back. A knob shared by several
 * tests (when a market shock begins, the stock share of a replay) appears
 * under each of them and is the same setting everywhere.
 */
export interface StressKnob {
  param: keyof StressParams;
  label: string;
  hint?: string;
  unit: string;
  step?: number;
  /** The stored value as typed: 0.02 -> 2 for a percentage. */
  toInput: (v: number) => number;
  /** The typed value as stored, clamped where it must be. */
  fromInput: (n: number) => number;
}

const pctPts = (param: keyof StressParams, label: string, hint?: string): StressKnob => ({
  param,
  label,
  hint,
  unit: "pts",
  step: 0.5,
  toInput: (v) => Math.round(v * 1000) / 10,
  fromInput: (n) => n / 100,
});
const pct = (param: keyof StressParams, label: string, hint?: string, clamp: (n: number) => number = (n) => n): StressKnob => ({
  param,
  label,
  hint,
  unit: "%",
  toInput: (v) => Math.round(v * 100),
  fromInput: (n) => clamp(n / 100),
});
const whole = (param: keyof StressParams, label: string, unit: string, hint?: string, min = 0): StressKnob => ({
  param,
  label,
  hint,
  unit,
  toInput: (v) => v,
  fromInput: (n) => Math.max(min, Math.round(n)),
});

const SHOCK_START = whole(
  "sequenceOffsetYears",
  "Begins: years after retirement",
  "yrs",
  "Every bear market and historical replay starts this many years after the first retirement (0 = the retirement year). Year five is often worse than year one: contributions have stopped and Social Security has not started."
);
const EQUITY_SHARE = pct("equityShare", "Share in stocks", "The replays lay real history over the plan for a portfolio this much in U.S. stocks, the rest in 10-year Treasuries, after inflation.", (x) => Math.min(1, Math.max(0, x)));
const RETURN_DELTA = pctPts("returnDelta", "Change in yearly return", "Added to every investment account's yearly return for the whole plan. Negative = worse.");
const CRASH = pct("crashReturn", "Return in the first year", "Investments earn exactly this in the year the shock begins, then their normal return. No rebound is assumed.");
const INFLATION_DELTA = pctPts("inflationDelta", "Change in inflation", "Added to the plan's inflation rate for the whole plan.");

const FIXED: Partial<Record<StressKey, StressKnob[]>> = {
  lower_returns: [RETURN_DELTA],
  bear_at_retirement: [CRASH, SHOCK_START],
  long_bear: [pct("bearTotalDrop", "Total fall", "The total loss across the bear years, spread evenly."), whole("bearYears", "Over how many years", "yrs", undefined, 1), SHOCK_START],
  higher_inflation: [INFLATION_DELTA],
  all_at_once: [RETURN_DELTA, CRASH, INFLATION_DELTA],
  live_longer: [whole("extraYears", "Extra years", "yrs", "Added to everyone's planning end age.")],
  spouse_dies_early: [whole("earlyDeathAge", "Dies at age", "age", "The household member the plan leans on most is modelled as dying at this age.", 1)],
  long_term_care: [
    { param: "ltcMonthly", label: "Monthly cost", hint: "Today's dollars. A private room in a nursing home runs $9,000-$12,000 a month in most of the country; assisted living about half that.", unit: "$/mo", step: 500, toInput: (v) => v, fromInput: (n) => Math.max(0, n) },
    whole("ltcYears", "Years of care", "yrs", "The average stay is two to three years; one in five lasts five or more.", 1),
    whole("ltcStartAge", "Starts at age", "age", "Care begins on the oldest person's birthday at this age (pulled earlier if it would fall past their planning end age).", 1),
  ],
  forced_early_exit: [whole("earlyExitYears", "Years early", "yrs", "Everyone still working retires this many years before they planned to.")],
  spending_overrun: [pct("spendingOverrunPct", "Runs over by", "Every entered expense and retirement spending runs this much higher, for the whole plan.")],
  healthcare_blowup: [pctPts("healthcareExtraGrowthPct", "Extra cost growth", "Added to the healthcare model's yearly cost growth. The marketplace premium credit is also removed.")],
  higher_taxes: [pctPts("taxDeltaPct", "Extra rate", "Added to the flat tax rate on retirement income: withdrawals, pension, taxable Social Security and gains.")],
  benefit_haircut: [pct("benefitCutPct", "Pays less by", "Every Social Security benefit is cut by this share from its first check.")],
  pension_no_cola: [],
};

/** The knobs for one test; a historical replay shares the two every replay uses. */
export function knobsFor(key: StressKey): StressKnob[] {
  if (key.startsWith("history_")) return [EQUITY_SHARE, SHOCK_START];
  return FIXED[key] ?? [];
}
