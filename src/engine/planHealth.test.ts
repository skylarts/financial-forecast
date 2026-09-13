import { describe, expect, it } from "vitest";
import { forecastScenario } from "./forecastScenario";
import { firstShortfallYear, holdsThroughLabel, spendingCoveredYears } from "./planHealth";
import { makeAccount, makeExpense, makeScenario } from "./testHelpers";

describe("planHealth", () => {
  it("reads the first year the plan runs short, and says so", () => {
    const cash = makeAccount({ class: "cash", name: "Savings", startingBalance: 30_000, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash],
      expenses: [makeExpense({ amount: 2_000 })],
      moneyFlow: { splitOrder: [], drainOrder: [] },
      withdrawalStrategy: "conventional",
      horizonEndDate: "2028-12-31",
    });
    const r = forecastScenario(scenario);
    // $24k a year against $30k: the second year runs out.
    expect(firstShortfallYear(r)).toBe(2027);
    expect(holdsThroughLabel(r)).toBe("Runs short in 2027");
    expect(holdsThroughLabel({ warnings: [] })).toBe("End of plan");
  });

  it("measures years of spending covered by investable accounts, leaving the home out", () => {
    const cash = makeAccount({ class: "cash", name: "Savings", startingBalance: 100_000, growthRatePct: 0 });
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash, home],
      expenses: [makeExpense({ amount: 2_000 })],
      moneyFlow: { splitOrder: [], drainOrder: [] },
      withdrawalStrategy: "conventional",
    });
    const r = forecastScenario(scenario);
    // $76k left after a $24k year, against $24k of spending.
    expect(spendingCoveredYears(r, 2026)).toBeCloseTo(76_000 / 24_000, 2);
    expect(spendingCoveredYears(r, 1999)).toBeNull();
  });
});
