import { describe, it, expect } from "vitest";
import { scenarioSchema } from "./scenario";

function baseScenario(accounts: unknown[]) {
  return {
    id: "s1",
    name: "Test",
    household: { people: [{ id: "p1", name: "Person", birthDate: "1970-01-01", retirementAge: 65, planningEndAge: 95 }] },
    accounts,
    incomeSources: [],
    expenses: [],
    events: [],
    settings: { startDate: "2026-01-01", horizonEndDate: "2026-12-31", inflationRatePct: 0.03 },
  };
}

describe("scenarioSchema -- Extra Savings auto-inject", () => {
  it("prepends a fresh Extra Savings account when none exists", () => {
    const parsed = scenarioSchema.parse(baseScenario([{ id: "checking", name: "Checking", class: "cash", category: "asset", ownerId: null, startingBalance: 1000, growthRatePct: 0 }]));
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[0].isExtraSavings).toBe(true);
    expect(parsed.accounts[0].name).toBe("Extra Savings");
    expect(parsed.accounts[0].startingBalance).toBe(0);
  });

  it("leaves accounts untouched when an Extra Savings account already exists", () => {
    const parsed = scenarioSchema.parse(
      baseScenario([
        { id: "checking", name: "Checking", class: "cash", category: "asset", ownerId: null, startingBalance: 1000, growthRatePct: 0 },
        { id: "es", name: "My Extra Savings", class: "cash", category: "asset", ownerId: null, startingBalance: 500, growthRatePct: 0, isExtraSavings: true },
      ])
    );
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts.filter((a) => a.isExtraSavings)).toHaveLength(1);
    expect(parsed.accounts.find((a) => a.isExtraSavings)?.id).toBe("es");
  });

  it("is idempotent -- parsing an already-parsed scenario doesn't add a second Extra Savings account", () => {
    const once = scenarioSchema.parse(baseScenario([]));
    const twice = scenarioSchema.parse(once);
    expect(twice.accounts.filter((a) => a.isExtraSavings)).toHaveLength(1);
  });
});
