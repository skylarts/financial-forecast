import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { DEFAULT_HEALTHCARE_SETTINGS, resolveAnchoredDates } from "@/domain";
import { projectScenario } from "./forecastScenario";
import { firstShortfallYear } from "./planHealth";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";
import {
  DEFAULT_STRESS_PARAMS,
  STRESS_PRESETS,
  applicableStressPresets,
  applyStress,
  expectedReturnOf,
  retirementYearOf,
  stressPreset,
  type StressKey,
} from "./stress";
import { HISTORICAL_ERAS, HISTORICAL_ERA_YEARS, MARKET_HISTORY, marketWindow, realBlendedReturn } from "./historicalReturns";

/** Guards the expanded stress presets: each one changes exactly what it says and leaves the base plan untouched. */

const person = (name: string, birthDate: string, retirementAge: number, planningEndAge = 95) => ({
  id: nanoid(),
  name,
  birthDate,
  retirementAge,
  planningEndAge,
});

function household() {
  const a = person("Ava", "1980-03-01", 60);
  const b = person("Ben", "1982-07-01", 62);
  const fund = makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 800_000, growthRatePct: 0.06, withdrawalPriority: 1 });
  const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 400_000, growthRatePct: 0.05, ownerId: a.id, withdrawalPriority: 2 });
  const salary = makeIncome({ name: "Ava salary", amount: 6_000, ownerId: a.id, category: "salary", endAnchor: { personId: a.id, point: "retirement", offsetMonths: 0 } });
  const pension = makeIncome({ name: "Ava pension", amount: 2_000, ownerId: a.id, category: "pension", growthRatePct: null, startAnchor: { personId: a.id, point: "retirement", offsetMonths: 0 } });
  const ss = makeIncome({ name: "Ben SS", amount: 1_500, ownerId: b.id, category: "social_security", startDate: "2049-07-01" });
  const rent = makeExpense({ name: "Living", amount: 5_000, category: "other" });
  // Anchored dates are resolved here the way the store and the schema do,
  // so the base run is not carrying stale dates a preset would then refresh.
  const scenario = resolveAnchoredDates(
    makeScenario({
      accounts: [fund, ira],
      people: [a, b],
      incomeSources: [salary, pension, ss],
      expenses: [rent],
      horizonEndDate: "2077-12-31",
      inflationRatePct: 0.03,
    })
  );
  return { scenario, a, b, fund, ira, salary, pension, ss, rent };
}

describe("historical market data", () => {
  it("is one contiguous row per year with plausible magnitudes", () => {
    for (let i = 1; i < MARKET_HISTORY.length; i++) expect(MARKET_HISTORY[i].year).toBe(MARKET_HISTORY[i - 1].year + 1);
    for (const row of MARKET_HISTORY) {
      expect(Math.abs(row.stocks)).toBeLessThan(0.6);
      expect(Math.abs(row.bonds)).toBeLessThan(0.4);
      expect(Math.abs(row.inflation)).toBeLessThan(0.2);
    }
  });
  it("has the famous years where they belong", () => {
    const byYear = new Map(MARKET_HISTORY.map((r) => [r.year, r]));
    expect(byYear.get(1931)?.stocks).toBeLessThan(-0.4);
    expect(byYear.get(1974)?.inflation).toBeGreaterThan(0.1);
    expect(byYear.get(2008)?.stocks).toBeLessThan(-0.3);
    expect(byYear.get(2022)?.bonds).toBeLessThan(-0.1);
  });
  it("blends stocks and bonds and takes inflation out", () => {
    const row = { year: 2000, stocks: 0.1, bonds: 0.05, inflation: 0.02 };
    expect(realBlendedReturn(row, 1)).toBeCloseTo(1.1 / 1.02 - 1, 10);
    expect(realBlendedReturn(row, 0)).toBeCloseTo(1.05 / 1.02 - 1, 10);
    expect(realBlendedReturn(row, 0.6)).toBeCloseTo(1.08 / 1.02 - 1, 10);
  });
  it("cuts a window and every era fits inside history", () => {
    expect(marketWindow(2000, 3).map((r) => r.year)).toEqual([2000, 2001, 2002]);
    expect(marketWindow(1900, 3)).toEqual([]);
    for (const era of HISTORICAL_ERAS) expect(marketWindow(era.startYear, HISTORICAL_ERA_YEARS)).toHaveLength(HISTORICAL_ERA_YEARS);
  });
});

describe("stress presets", () => {
  const { scenario, a, b, pension, ss, rent } = household();
  const base = JSON.stringify(scenario);

  it("never mutates the base plan", () => {
    for (const preset of STRESS_PRESETS) preset.apply(scenario, DEFAULT_STRESS_PARAMS);
    expect(JSON.stringify(scenario)).toBe(base);
  });

  it("describes every preset without throwing, naming the people it acts on", () => {
    for (const preset of STRESS_PRESETS) expect(preset.describe(DEFAULT_STRESS_PARAMS, scenario).length).toBeGreaterThan(20);
    expect(stressPreset("spouse_dies_early")!.describe(DEFAULT_STRESS_PARAMS, scenario)).toContain("Ava");
    expect(stressPreset("long_term_care")!.describe(DEFAULT_STRESS_PARAMS, scenario)).toContain("Ava");
  });

  it("anchors sequence shocks to the first retirement, offset by the parameter", () => {
    expect(retirementYearOf(scenario)).toBe(2040);
    expect(applyStress(scenario, "bear_at_retirement").options.yearReturnOverride).toEqual({ year: 2040, ratePct: -0.3 });
    const later = applyStress(scenario, "bear_at_retirement", { ...DEFAULT_STRESS_PARAMS, sequenceOffsetYears: 5 });
    expect(later.options.yearReturnOverride?.year).toBe(2045);
  });

  it("spreads a long bear evenly so the years compound to the total fall", () => {
    const { options } = applyStress(scenario, "long_bear", { ...DEFAULT_STRESS_PARAMS, bearYears: 3, bearTotalDrop: -0.4 });
    const map = options.yearReturnOverrides!;
    expect(Object.keys(map).map(Number)).toEqual([2040, 2041, 2042]);
    const compounded = Object.values(map).reduce((f, r) => f * (1 + r), 1);
    expect(compounded).toBeCloseTo(0.6, 10);
  });

  it("replays an era's real returns for a blended portfolio, plus the plan's inflation", () => {
    const { options } = applyStress(scenario, "history_1973", { ...DEFAULT_STRESS_PARAMS, equityShare: 0.6 });
    const map = options.yearReturnOverrides!;
    expect(Object.keys(map)).toHaveLength(HISTORICAL_ERA_YEARS);
    const row1974 = MARKET_HISTORY.find((r) => r.year === 1974)!;
    expect(map[2041]).toBeCloseTo(realBlendedReturn(row1974, 0.6) + 0.03, 10);
    // 1974 was a real loss for a 60/40 investor even after adding the plan's inflation back.
    expect(map[2041]).toBeLessThan(0);
  });

  it("kills the larger earner at the chosen age and shortens the horizon to the survivor", () => {
    const s = applyStress(scenario, "spouse_dies_early").scenario;
    expect(s.household.people.find((p) => p.id === a.id)!.planningEndAge).toBe(70);
    expect(s.household.people.find((p) => p.id === b.id)!.planningEndAge).toBe(95);
    expect(s.settings.horizonEndDate).toBe("2077-12-31");
    const bigDies = applyStress({ ...scenario, household: { people: [{ ...a, planningEndAge: 100 }, { ...b, planningEndAge: 80 }] }, settings: { ...scenario.settings, horizonEndDate: "2080-12-31" } }, "spouse_dies_early").scenario;
    expect(bigDies.settings.horizonEndDate).toBe("2062-12-31");
  });

  it("adds a long-term care expense for the oldest person, pulled back to fit their life", () => {
    const s = applyStress(scenario, "long_term_care").scenario;
    const care = s.expenses.find((e) => e.id === "stress:long_term_care")!;
    expect(care.name).toBe("Long-term care: Ava");
    expect(care.startDate).toBe("2062-03-01");
    expect(care.endDate).toBe("2065-02-28");
    expect(care.amount).toBe(9_000);
    const short = applyStress({ ...scenario, household: { people: [{ ...a, planningEndAge: 83 }, b] } }, "long_term_care").scenario;
    expect(short.expenses.find((e) => e.id === "stress:long_term_care")!.startDate).toBe("2060-03-01");
  });

  it("moves every future retirement earlier and re-resolves the dates anchored to it", () => {
    const s = applyStress(scenario, "forced_early_exit").scenario;
    const ava = s.household.people.find((p) => p.id === a.id)!;
    expect(ava.retirementDate).toBe("2038-03-01");
    expect(s.incomeSources.find((i) => i.id === pension.id)!.startDate).toBe("2038-03-01");
    expect(s.incomeSources.find((i) => i.name === "Ava salary")!.endDate).toBe("2038-02-28");
    // Someone already retired is left alone.
    const retired = { ...scenario, household: { people: [{ ...a, retirementDate: "2020-01-01" }, b] } };
    expect(applyStress(retired, "forced_early_exit").scenario.household.people[0].retirementDate).toBe("2020-01-01");
  });

  it("scales expenses and retirement spending, raises the flat tax, cuts Social Security, freezes pensions", () => {
    const withSpend = { ...scenario, household: { people: [{ ...a, retirementSpending: { amount: 12_000, growthRatePct: null, paymentAccountId: null } }, b] } };
    const over = applyStress(withSpend, "spending_overrun").scenario;
    expect(over.expenses.find((e) => e.id === rent.id)!.amount).toBeCloseTo(5_750, 6);
    expect(over.household.people[0].retirementSpending!.amount).toBeCloseTo(13_800, 6);
    expect(applyStress(scenario, "higher_taxes").scenario.settings.additionalFlatTaxRatePct).toBeCloseTo(0.03, 10);
    expect(applyStress(scenario, "benefit_haircut").scenario.incomeSources.find((i) => i.id === ss.id)!.amount).toBeCloseTo(1_200, 6);
    expect(applyStress(scenario, "pension_no_cola").scenario.incomeSources.find((i) => i.id === pension.id)!.growthRatePct).toBe(0);
  });

  it("raises healthcare growth and drops the premium credit only when the model is on", () => {
    expect(stressPreset("healthcare_blowup")!.applies(scenario)).toBe(false);
    const on = { ...scenario, settings: { ...scenario.settings, healthcare: { ...DEFAULT_HEALTHCARE_SETTINGS, enabled: true, costGrowthRatePct: 0.05 } } };
    const s = applyStress(on, "healthcare_blowup").scenario;
    expect(s.settings.healthcare.costGrowthRatePct).toBeCloseTo(0.08, 10);
    expect(s.settings.healthcare.marketplace.premiumTaxCredit).toBe(false);
  });

  it("only offers the presets the plan has something for", () => {
    const keys = (s: typeof scenario) => applicableStressPresets(s).map((p) => p.key);
    expect(keys(scenario)).toContain("pension_no_cola");
    expect(keys(scenario)).toContain("spouse_dies_early");
    expect(keys(scenario)).not.toContain("healthcare_blowup");
    const solo = { ...scenario, household: { people: [a] }, incomeSources: scenario.incomeSources.filter((i) => i.category === "salary") };
    expect(keys(solo)).not.toContain("spouse_dies_early");
    expect(keys(solo)).not.toContain("benefit_haircut");
    expect(keys(solo)).not.toContain("pension_no_cola");
    const flatPension = { ...scenario, incomeSources: scenario.incomeSources.map((i) => (i.category === "pension" ? { ...i, growthRatePct: 0 } : i)) };
    expect(keys(flatPension)).not.toContain("pension_no_cola");
  });

  it("every lever's harmless end reproduces the base run (a 0% year is a mild stress, not a no-op)", () => {
    const baseEnd = projectScenario(scenario).kpis.netWorthAtEndReal;
    const flatYearIsStillAStress = new Set<StressKey>(["bear_at_retirement", "long_bear"]);
    for (const preset of STRESS_PRESETS) {
      if (!preset.lever || !preset.applies(scenario)) continue;
      const run = preset.apply(scenario, { ...DEFAULT_STRESS_PARAMS, [preset.lever.param]: preset.lever.from });
      const end = projectScenario(run.scenario, run.options).kpis.netWorthAtEndReal;
      if (flatYearIsStillAStress.has(preset.key)) expect(end, preset.key).toBeLessThan(baseEnd);
      else expect(end, preset.key).toBeCloseTo(baseEnd, 0);
    }
  });

  it("every applicable preset ends no better than the base plan, in today's dollars (a replay may: history can beat a cautious plan)", () => {
    // Compared in the base plan's final year, so a run that lasts longer
    // (Live longer) is not credited for its extra years -- the tab's rule.
    const baseRun = projectScenario(scenario);
    const baseEndYear = baseRun.years[baseRun.years.length - 1].year;
    const baseEnd = baseRun.kpis.netWorthAtEndReal;
    const worse: StressKey[] = [];
    for (const preset of applicableStressPresets(scenario)) {
      const run = preset.apply(scenario, DEFAULT_STRESS_PARAMS);
      const result = projectScenario(run.scenario, run.options);
      const end = result.years.find((y) => y.year === baseEndYear)?.netWorthReal ?? result.kpis.netWorthAtEndReal;
      if (!preset.key.startsWith("history_")) expect(end, preset.key).toBeLessThanOrEqual(baseEnd + 1);
      if (end < baseEnd - 1) worse.push(preset.key);
    }
    expect(worse).toContain("lower_returns");
    expect(worse).toContain("long_term_care");
    expect(worse).toContain("history_1966");
  });

  it("reads the plan's expected return from the plan-wide rate, else the balance-weighted account rates", () => {
    expect(expectedReturnOf(scenario)).toBeCloseTo((0.06 * 800_000 + 0.05 * 400_000) / 1_200_000, 10);
    expect(expectedReturnOf({ ...scenario, settings: { ...scenario.settings, planReturnRatePct: 0.07 } })).toBe(0.07);
    expect(expectedReturnOf({ ...scenario, accounts: scenario.accounts.filter((x) => x.class === "cash") })).toBeCloseTo(0.07, 10);
  });

  it("a plan that barely holds breaks under spending overrun but not under a frozen pension it never had", () => {
    const tight = makeScenario({
      accounts: [makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 300_000, growthRatePct: 0.04, withdrawalPriority: 1 })],
      people: [person("Solo", "1961-01-01", 65)],
      expenses: [makeExpense({ amount: 1_150 })],
      horizonEndDate: "2056-12-31",
      inflationRatePct: 0.03,
    });
    expect(firstShortfallYear(projectScenario(tight))).toBeNull();
    const over = applyStress(tight, "spending_overrun", { ...DEFAULT_STRESS_PARAMS, spendingOverrunPct: 0.5 });
    expect(firstShortfallYear(projectScenario(over.scenario, over.options))).not.toBeNull();
    expect(applicableStressPresets(tight).map((p) => p.key)).not.toContain("pension_no_cola");
  });
});
