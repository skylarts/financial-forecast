import { describe, expect, it } from "vitest";
import { makeAccount, makeExpense, makeScenario } from "./testHelpers";
import { expectedReturnOf } from "./stress";
import { DEFAULT_MONTE_CARLO_PARAMS, generatePaths, mulberry32, planYears, summarizeMonteCarlo } from "./monteCarlo";
import type { StressSummary } from "./stressSummary";

/** Guards the random-path generator (seeded, centred on the plan) and the fan summary. */

const plan = () =>
  makeScenario({
    accounts: [
      makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 600_000, growthRatePct: 0.06 }),
      makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 400_000, growthRatePct: 0.05 }),
    ],
    expenses: [makeExpense({ amount: 2_000 })],
    horizonEndDate: "2055-12-31",
    inflationRatePct: 0.03,
  });

describe("paths", () => {
  it("are seeded: the same settings give the same paths, a new seed gives new ones", () => {
    const a = generatePaths(plan(), DEFAULT_MONTE_CARLO_PARAMS);
    const b = generatePaths(plan(), DEFAULT_MONTE_CARLO_PARAMS);
    const c = generatePaths(plan(), { ...DEFAULT_MONTE_CARLO_PARAMS, seed: 2 });
    expect(a).toEqual(b);
    expect(a[0]).not.toEqual(c[0]);
    expect(a).toHaveLength(500);
    expect(Object.keys(a[0]).map(Number)).toEqual(planYears(plan()));
  });
  it("centre on the plan's expected return under both models", () => {
    const expected = expectedReturnOf(plan());
    for (const model of ["history", "normal"] as const) {
      const paths = generatePaths(plan(), { ...DEFAULT_MONTE_CARLO_PARAMS, model, paths: 2_000 });
      let sum = 0;
      let count = 0;
      for (const p of paths) {
        for (const r of Object.values(p)) {
          sum += r;
          count += 1;
        }
      }
      expect(sum / count, model).toBeCloseTo(expected, 2);
    }
  });
  it("history draws are real years shifted, so a 1931-shaped year is still a big loss", () => {
    const paths = generatePaths(plan(), { ...DEFAULT_MONTE_CARLO_PARAMS, paths: 300 });
    const worst = Math.min(...paths.flatMap((p) => Object.values(p)));
    expect(worst).toBeLessThan(-0.2);
    expect(worst).toBeGreaterThanOrEqual(-0.95);
  });
  it("the generator is uniform on [0, 1)", () => {
    const rand = mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = rand();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
  });
});

describe("fan summary", () => {
  const summary = (end: number, shortYear: number | null): StressSummary => ({
    years: [2026, 2027, 2028].map((year, i) => ({ year, netWorthNominal: end * (i + 1), netWorthReal: end * (i + 1) * 0.9, investableNominal: 0, spendNominal: 0 })),
    endYear: 2028,
    netWorthAtEnd: end * 3,
    netWorthAtEndReal: end * 3 * 0.9,
    firstShortfallYear: shortYear,
    shortfallDepthNominal: 0,
    shortfallDepthReal: 0,
    lowestReal: { year: 2026, value: end * 0.9 },
  });
  it("reports the success rate, the percentile fan by year, and when failures land", () => {
    const r = summarizeMonteCarlo([summary(100, null), summary(200, null), summary(300, 2027), summary(400, 2028), summary(500, null)]);
    expect(r.paths).toBe(5);
    expect(r.successRate).toBeCloseTo(0.6, 10);
    expect(r.years.map((y) => y.year)).toEqual([2026, 2027, 2028]);
    expect(r.years[0].p50).toBe(300);
    expect(r.years[0].p10).toBeCloseTo(140, 10);
    expect(r.years[0].p90).toBeCloseTo(460, 10);
    expect(r.years[2].p50Real).toBeCloseTo(900 * 0.9, 10);
    expect(r.years.map((y) => y.shortBy)).toEqual([0, 0.2, 0.4]);
    expect(r.medianShortfallYear).toBe(2027);
  });
  it("handles no paths and no failures", () => {
    expect(summarizeMonteCarlo([]).paths).toBe(0);
    const r = summarizeMonteCarlo([summary(1, null)]);
    expect(r.successRate).toBe(1);
    expect(r.medianShortfallYear).toBeNull();
  });
});
