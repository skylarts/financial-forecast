import { describe, it, expect } from "vitest";
import { projectScenario } from "./forecastScenario";
import { traceYear } from "./traceYear";
import { makeAccount, makeScenario, makeIncome, makeExpense } from "./testHelpers";
import type { MoneyFlow } from "@/domain";

function buildScenario(moneyFlow: (checkingId: string, brokerageId: string) => MoneyFlow) {
  const checking = makeAccount({ class: "cash", name: "Checking+Savings", startingBalance: 400_000, growthRatePct: 0.01 });
  const brokerage = makeAccount({
    class: "taxable_investment",
    name: "Joint Brokerage",
    startingBalance: 3_000_000,
    growthRatePct: 0.06,
    taxTreatment: "taxable",
  });
  const scenario = makeScenario({
    accounts: [checking, brokerage],
    startDate: "2026-01-01",
    horizonEndDate: "2028-12-31",
    inflationRatePct: 0.03,
    incomeSources: [makeIncome({ depositAccountId: checking.id, name: "Salary", amount: 12_000, frequency: "monthly" })],
    expenses: [makeExpense({ paymentAccountId: checking.id, name: "Living", amount: 20_000, frequency: "monthly" })],
    moneyFlow: moneyFlow(checking.id, brokerage.id),
  });
  return { scenario, checking, brokerage };
}

describe("hub buffer vs fill cap on the same account", () => {
  const conflicting = (checkingId: string, brokerageId: string): MoneyFlow => ({
    // Keep a $300k buffer in the hub...
    hubs: [{ accountId: checkingId, bufferAmount: 300_000 }],
    // ...while the SAME account is a fill stop capped at $100k.
    fillOrder: [
      { accountId: checkingId, maxBalance: 100_000, maxBalanceGrowthRatePct: null, splitPct: null },
      { accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null },
    ],
    drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null }],
    fillSplitMode: "priority_fill",
    drainSplitMode: "priority_fill",
  });

  it("does not churn the buffer out and back every month", () => {
    const { scenario } = buildScenario(conflicting);
    const result = projectScenario(scenario);

    for (const year of result.years) {
      const cf = year.cashFlow;
      const gross = cf.withdrawalsByAccount.reduce((s, w) => s + w.gross, 0);
      // Real need is expenses minus income (~$96k/yr). Anything near the
      // $2.4M/yr the churn produced is the same dollars crossing back and forth.
      expect(gross).toBeLessThan(cf.totalExpenses);
    }
  });

  it("keeps the hub at its buffer rather than the lower cap", () => {
    const { scenario } = buildScenario(conflicting);
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    // Buffer wins: hub holds ~$300k, not the conflicting $100k cap.
    expect(y2026.cashFlow.endingCashBalance).toBeCloseTo(300_000, -2);
  });

  it("warns that the cap is being overridden by the buffer", () => {
    const { scenario, checking } = buildScenario(conflicting);
    const result = projectScenario(scenario);
    const warning = result.warnings.find((w) => w.kind === "routing_conflict");
    expect(warning).toBeDefined();
    expect(warning!.accountId).toBe(checking.id);
  });

  it("still enforces a cap on a non-hub fill stop", () => {
    // Regression guard: the fix must not disable capping generally.
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 0, growthRatePct: 0 });
    const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 500_000, growthRatePct: 0 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 0, growthRatePct: 0, taxTreatment: "taxable" });
    const scenario = makeScenario({
      accounts: [checking, savings, brokerage],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
      inflationRatePct: 0,
      moneyFlow: {
        hubs: [{ accountId: checking.id, bufferAmount: 50_000 }],
        fillOrder: [
          { accountId: savings.id, maxBalance: 100_000, maxBalanceGrowthRatePct: null, splitPct: null },
          { accountId: brokerage.id, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null },
        ],
        drainOrder: [],
        fillSplitMode: "priority_fill",
        drainSplitMode: "priority_fill",
      },
    });
    const result = projectScenario(scenario);
    const y = result.years[0];
    expect(y.accountBalances[savings.id]).toBeCloseTo(100_000, -2); // capped
    expect(y.accountBalances[brokerage.id]).toBeCloseTo(350_000, -2); // overflow spilled onward
    expect(y.accountBalances[checking.id]).toBeCloseTo(50_000, -2); // buffer kept
  });

  it("traceYear renders the year (smoke)", () => {
    const { scenario } = buildScenario(conflicting);
    const result = projectScenario(scenario);
    const trace = traceYear(result, scenario, 2026);
    console.log("\n" + trace + "\n");
    expect(trace).toContain("money-flow trace");
  });
});

describe("hub floor/ceiling (replaces the old self-referencing fill-order trap)", () => {
  it("sweeps a surplus above the ceiling on day one, without also touching the floor", () => {
    const { scenario } = buildScenario((checkingId, brokerageId) => ({
      hubs: [{ accountId: checkingId, bufferAmount: 50_000, ceilingAmount: 100_000, ceilingGrowthRatePct: null }],
      fillOrder: [{ accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
      drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null }],
      fillSplitMode: "priority_fill",
      drainSplitMode: "priority_fill",
    }));
    // Starting balance ($400k) is above the $100k ceiling, so the very first
    // month sweeps it down to the ceiling (not all the way to the floor) --
    // proof the two numbers are independent, not the same trigger point.
    const result = projectScenario(scenario);
    const january = result.ledger.find((e) => e.kind === "surplus_route" && e.date === "2026-01-01");
    expect(january).toBeDefined();
    // $400k start + $12k income - $20k expense - $100k ceiling = $292k swept.
    expect(january!.amount).toBeCloseTo(292_000, 0);
  });

  it("does not churn when expenses drain the hub from the ceiling down toward the floor over the year", () => {
    const { scenario } = buildScenario((checkingId, brokerageId) => ({
      hubs: [{ accountId: checkingId, bufferAmount: 50_000, ceilingAmount: 100_000, ceilingGrowthRatePct: null }],
      fillOrder: [{ accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
      drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null }],
      fillSplitMode: "priority_fill",
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    const gross = y2026.cashFlow.withdrawalsByAccount.reduce((s, w) => s + w.gross, 0);
    expect(gross).toBeLessThan(y2026.cashFlow.totalExpenses); // no phantom churn
  });

  it("without a ceilingAmount, falls back to the old single-number (floor-is-ceiling) behavior", () => {
    const { scenario, checking } = buildScenario((checkingId, brokerageId) => ({
      hubs: [{ accountId: checkingId, bufferAmount: 300_000, ceilingAmount: null, ceilingGrowthRatePct: null }],
      fillOrder: [{ accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
      drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null }],
      fillSplitMode: "priority_fill",
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    expect(y2026.accountBalances[checking.id]).toBeCloseTo(300_000, -1);
  });

  it("clamps a ceiling set below the floor, rather than letting the two fight each other", () => {
    const { scenario, checking } = buildScenario((checkingId, brokerageId) => ({
      hubs: [{ accountId: checkingId, bufferAmount: 300_000, ceilingAmount: 100_000, ceilingGrowthRatePct: null }],
      fillOrder: [{ accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
      drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null }],
      fillSplitMode: "priority_fill",
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    for (const year of result.years) {
      const gross = year.cashFlow.withdrawalsByAccount.reduce((s, w) => s + w.gross, 0);
      expect(gross).toBeLessThan(year.cashFlow.totalExpenses);
    }
    expect(result.years[0].accountBalances[checking.id]).toBeCloseTo(300_000, -1);
  });
});

describe("deficit cascade with a self-referential drain stop", () => {
  it("cannot cover a shortfall when the hub is its own only drain source", () => {
    const checking = makeAccount({ class: "cash", name: "Checking+Savings", startingBalance: 100_000, growthRatePct: 0 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Joint Brokerage", startingBalance: 3_000_000, growthRatePct: 0.06, taxTreatment: "taxable" });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
      inflationRatePct: 0,
      expenses: [makeExpense({ paymentAccountId: checking.id, name: "Living", amount: 20_000, frequency: "monthly" })],
      moneyFlow: {
        hubs: [{ accountId: checking.id, bufferAmount: 0 }],
        fillOrder: [],
        // The only drain stop IS the hub -- drawFromSource no-ops on self.
        drainOrder: [{ id: "d1", accountId: checking.id, startDate: null, endDate: null, splitPct: null, minBalance: null }],
        fillSplitMode: "priority_fill",
        drainSplitMode: "priority_fill",
      },
    });
    const result = projectScenario(scenario);
    const y2028 = result.years.find((y) => y.year === 2028)!;
    console.log("\n" + traceYear(result, scenario, 2028) + "\n");
    // Documents the observed shape: $0 withdrawn, hub deeply negative,
    // brokerage untouched and compounding.
    expect(y2028.cashFlow.withdrawalsByAccount).toHaveLength(0);
    expect(y2028.cashFlow.endingCashBalance).toBeLessThan(0);
    expect(y2028.accountBalances[brokerage.id]).toBeGreaterThan(3_000_000);
  });
});
