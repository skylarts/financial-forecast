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

/**
 * Balance bounds moved off the routing stops onto the accounts they describe.
 * scenarioSchema lifts any legacy stop-level value across on parse, so a plan
 * saved under the old shape keeps behaving identically with no separate
 * migration step -- the same approach as the Extra Savings auto-inject above.
 */
describe("scenarioSchema -- legacy stop bounds migrate onto accounts", () => {
  const checking = { id: "checking", name: "Checking", class: "cash", category: "asset", ownerId: null, startingBalance: 1000, growthRatePct: 0 };
  const brokerage = { id: "brokerage", name: "Brokerage", class: "taxable_investment", category: "asset", ownerId: null, startingBalance: 500_000, growthRatePct: 0 };

  function withMoneyFlow(splitOrder: unknown[], drainOrder: unknown[]) {
    const base = baseScenario([checking, brokerage]);
    return { ...base, settings: { ...base.settings, moneyFlow: { splitOrder, drainOrder } } };
  }

  it("lifts a split stop's maxBalance onto the target account and clears the stop", () => {
    const parsed = scenarioSchema.parse(
      withMoneyFlow([{ id: "s1", accountId: "checking", kind: "percent_of_remainder", pct: 1, maxBalance: 25_000, maxBalanceGrowthRatePct: 0 }], [])
    );
    expect(parsed.accounts.find((a) => a.id === "checking")?.balanceCeiling).toBe(25_000);
    expect(parsed.accounts.find((a) => a.id === "checking")?.balanceCeilingGrowthRatePct).toBe(0);
    expect(parsed.settings.moneyFlow.splitOrder[0].maxBalance).toBeNull();
  });

  it("lifts a drain stop's minBalance onto the source account and clears the stop", () => {
    const parsed = scenarioSchema.parse(
      withMoneyFlow([], [{ id: "d1", accountId: "brokerage", kind: "percent_of_remainder", pct: 1, minBalance: 100_000, minBalanceGrowthRatePct: 0.1 }])
    );
    expect(parsed.accounts.find((a) => a.id === "brokerage")?.balanceFloor).toBe(100_000);
    expect(parsed.accounts.find((a) => a.id === "brokerage")?.balanceFloorGrowthRatePct).toBe(0.1);
    expect(parsed.settings.moneyFlow.drainOrder[0].minBalance).toBeNull();
  });

  it("takes the first stop's bound when one account appears in several stops", () => {
    // The old schema allowed per-stop bounds an account-level one can't
    // express; the highest-priority stop is the one that governed in practice.
    const parsed = scenarioSchema.parse(
      withMoneyFlow([], [
        { id: "d1", accountId: "brokerage", kind: "percent_of_remainder", pct: 1, minBalance: 100_000, minBalanceGrowthRatePct: null, endDate: "2035-12-31" },
        { id: "d2", accountId: "brokerage", kind: "percent_of_remainder", pct: 1, minBalance: 0, minBalanceGrowthRatePct: null, startDate: "2036-01-01" },
      ])
    );
    expect(parsed.accounts.find((a) => a.id === "brokerage")?.balanceFloor).toBe(100_000);
  });

  it("does not overwrite a bound already set on the account", () => {
    const parsed = scenarioSchema.parse({
      ...withMoneyFlow([{ id: "s1", accountId: "checking", kind: "percent_of_remainder", pct: 1, maxBalance: 25_000, maxBalanceGrowthRatePct: null }], []),
      accounts: [{ ...checking, balanceCeiling: 40_000 }, brokerage],
    });
    expect(parsed.accounts.find((a) => a.id === "checking")?.balanceCeiling).toBe(40_000);
  });

  it("leaves a scenario with no legacy bounds untouched", () => {
    const parsed = scenarioSchema.parse(
      withMoneyFlow([{ id: "s1", accountId: "checking", kind: "percent_of_remainder", pct: 1 }], [])
    );
    expect(parsed.accounts.find((a) => a.id === "checking")?.balanceCeiling ?? null).toBeNull();
  });
});
