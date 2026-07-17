import { describe, it, expect } from "vitest";
import { projectScenario } from "./forecastScenario";
import { traceYear } from "./traceYear";
import { makeAccount, makeScenario, makeIncome, makeExpense } from "./testHelpers";
import type { MoneyFlow } from "@/domain";

/**
 * `extraSavings` is explicitly built with `isSpendingAccount: true` (mapped
 * to `isExtraSavings` by testHelpers) rather than relying on makeScenario's
 * auto-injected blank one, so these tests can control its id and starting
 * balance directly.
 */
function buildScenario(
  moneyFlow: (extraSavingsId: string, checkingId: string, brokerageId: string) => MoneyFlow,
  overrides?: { incomeAmount?: number; expenseAmount?: number }
) {
  const extraSavings = makeAccount({ class: "cash", name: "Extra Savings", startingBalance: 0, growthRatePct: 0, isSpendingAccount: true });
  const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 0, growthRatePct: 0 });
  const brokerage = makeAccount({
    class: "taxable_investment",
    name: "Joint Brokerage",
    startingBalance: 3_000_000,
    growthRatePct: 0.06,
    taxTreatment: "taxable",
  });
  const scenario = makeScenario({
    accounts: [extraSavings, checking, brokerage],
    startDate: "2026-01-01",
    horizonEndDate: "2027-12-31",
    inflationRatePct: 0.03,
    incomeSources: [
      makeIncome({ depositAccountId: extraSavings.id, name: "Salary", amount: overrides?.incomeAmount ?? 30_000, frequency: "monthly" }),
    ],
    expenses: [
      makeExpense({ paymentAccountId: extraSavings.id, name: "Living", amount: overrides?.expenseAmount ?? 20_000, frequency: "monthly" }),
    ],
    moneyFlow: moneyFlow(extraSavings.id, checking.id, brokerage.id),
  });
  return { scenario, extraSavings, checking, brokerage };
}

describe("Extra Savings split: flow-based, not stock-based", () => {
  it("leaves unclaimed money to accumulate across months instead of re-offering it to the split", () => {
    // $30k income - $20k expense = $10k/mo surplus. Checking claims a flat
    // $3k/mo, uncapped, leaving $7k/mo unclaimed in Extra Savings every month.
    const { scenario, extraSavings, checking } = buildScenario((extraSavingsId, checkingId) => ({
      splitOrder: [
        { id: "s1", accountId: checkingId, kind: "flat", amount: 3_000, pct: null, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
      ],
      drainOrder: [],
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    // If the split were stock-based (re-evaluated against Extra Savings'
    // WHOLE balance every month, not just that month's fresh surplus), the
    // flat $3k claim would keep being offered against an ever-larger pool,
    // and/or the leftover would get drawn down instead of genuinely growing.
    // Both balances should instead grow roughly linearly, 12 months of a
    // steady monthly split.
    expect(y2026.accountBalances[checking.id]).toBeCloseTo(3_000 * 12, -2);
    expect(y2026.accountBalances[extraSavings.id]).toBeCloseTo(7_000 * 12, -2);
  });

  it("keeps growing a deliberately-unclaimed reserve year over year rather than letting it plateau", () => {
    const { scenario, extraSavings } = buildScenario((extraSavingsId, checkingId) => ({
      splitOrder: [
        { id: "s1", accountId: checkingId, kind: "flat", amount: 3_000, pct: null, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
      ],
      drainOrder: [],
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!.accountBalances[extraSavings.id];
    const y2027 = result.years.find((y) => y.year === 2027)!.accountBalances[extraSavings.id];
    // A stock-based (re-swept-every-month) implementation would converge
    // toward a small steady amount instead of continuing to grow year over
    // year -- this is the actual behavior a real user reported wanting.
    expect(y2027).toBeGreaterThan(y2026 * 1.5);
  });
});

describe("Extra Savings split: cascading percentages", () => {
  it("computes each stop's percentage against the shrinking remainder, not the original total", () => {
    // $10k/mo surplus. Checking takes 50% (-> $5k), Brokerage takes 50% of
    // what's LEFT (-> 50% of the remaining $5k = $2.5k), $2.5k stays in
    // Extra Savings. A parallel-to-total (non-cascading) implementation
    // would instead give Brokerage 50% of the original $10k = $5k.
    const { scenario, checking, brokerage } = buildScenario((extraSavingsId, checkingId, brokerageId) => ({
      splitOrder: [
        { id: "s1", accountId: checkingId, kind: "percent_of_remainder", amount: null, pct: 0.5, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
        { id: "s2", accountId: brokerageId, kind: "percent_of_remainder", amount: null, pct: 0.5, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
      ],
      drainOrder: [],
      drainSplitMode: "priority_fill",
    }));
    const result = projectScenario(scenario);
    const routedToChecking = result.ledger.filter((e) => e.kind === "surplus_route" && e.toAccountId === checking.id && e.date === "2026-02-01");
    const routedToBrokerage = result.ledger.filter((e) => e.kind === "surplus_route" && e.toAccountId === brokerage.id && e.date === "2026-02-01");
    expect(routedToChecking[0]?.amount).toBeCloseTo(5_000, 0);
    expect(routedToBrokerage[0]?.amount).toBeCloseTo(2_500, 0);
  });
});

describe("Extra Savings split: balance caps still apply", () => {
  it("spills overflow to the next stop once a capped target is full", () => {
    const { scenario, checking } = buildScenario(
      (extraSavingsId, checkingId, brokerageId) => ({
        splitOrder: [
          { id: "s1", accountId: checkingId, kind: "percent_of_remainder", amount: null, pct: 1, maxBalance: 5_000, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
          { id: "s2", accountId: brokerageId, kind: "percent_of_remainder", amount: null, pct: 1, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null },
        ],
        drainOrder: [],
        drainSplitMode: "priority_fill",
      }),
      { incomeAmount: 30_000, expenseAmount: 20_000 }
    );
    const result = projectScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    // Checking fills to its $5k cap in month 1 and never absorbs more;
    // everything else (the rest of the year's $10k/mo surplus) spills to
    // brokerage instead of piling up in Extra Savings.
    expect(y2026.accountBalances[checking.id]).toBeCloseTo(5_000, -1);
  });
});

describe("automatic account routing", () => {
  it("an income/expense with no depositAccountId/paymentAccountId posts automatically through Extra Savings", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 0, growthRatePct: 0 });
    const scenario = makeScenario({
      // No account is tagged isSpendingAccount -- makeScenario auto-injects a
      // fresh Extra Savings account, mirroring scenarioSchema's transform.
      accounts: [checking],
      incomeSources: [makeIncome({ name: "Salary", amount: 5_000, frequency: "monthly" })], // depositAccountId omitted -> null
      expenses: [makeExpense({ name: "Living", amount: 3_000, frequency: "monthly" })], // paymentAccountId omitted -> null
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const extraSavings = scenario.accounts.find((a) => a.isExtraSavings)!;
    const result = projectScenario(scenario);
    const year = result.years[0];

    // $2k/mo net surplus, nowhere else to go (no splitOrder configured) -- it
    // all lands and stays in the auto-injected Extra Savings account.
    expect(year.accountBalances[extraSavings.id]).toBeCloseTo(24_000, 0);
    // Checking was never targeted by anything, so it's untouched.
    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
  });

  it("an explicit depositAccountId/paymentAccountId still overrides the automatic default", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 0, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [checking],
      // Explicitly directed at Checking -- e.g. an inheritance landing
      // straight in a specific account, bypassing Extra Savings entirely.
      incomeSources: [makeIncome({ name: "Inheritance", amount: 50_000, frequency: "one_time", depositAccountId: checking.id })],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const extraSavings = scenario.accounts.find((a) => a.isExtraSavings)!;
    const result = projectScenario(scenario);
    const year = result.years[0];

    expect(year.accountBalances[checking.id]).toBeCloseTo(50_000, 0);
    // Never touched Extra Savings at all.
    expect(year.accountBalances[extraSavings.id]).toBeCloseTo(0, 0);
  });
});

describe("Extra Savings deficit cascade", () => {
  it("still refills Extra Savings to its hardcoded $0 floor from an active drain source", () => {
    const { scenario, extraSavings } = buildScenario(
      (extraSavingsId, checkingId, brokerageId) => ({
        splitOrder: [],
        drainOrder: [{ id: "d1", accountId: brokerageId, startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null }],
        drainSplitMode: "priority_fill",
      }),
      { incomeAmount: 5_000, expenseAmount: 20_000 } // $15k/mo shortfall
    );
    const result = projectScenario(scenario);
    for (const year of result.years) {
      // Never meaningfully negative -- the drain cascade tops it back to $0
      // every month, same guarantee the old hub-buffer-of-0 case gave.
      expect(year.accountBalances[extraSavings.id]).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it("cannot cover a shortfall when Extra Savings is its own only drain source", () => {
    const { scenario, extraSavings, brokerage } = buildScenario(
      (extraSavingsId) => ({
        splitOrder: [],
        // The only drain stop IS Extra Savings itself -- drawFromSource no-ops on self.
        drainOrder: [{ id: "d1", accountId: extraSavingsId, startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null }],
        drainSplitMode: "priority_fill",
      }),
      { incomeAmount: 5_000, expenseAmount: 20_000 }
    );
    const result = projectScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!;
    console.log("\n" + traceYear(result, 2027) + "\n");
    // Documents the observed shape: nothing withdrawn, Extra Savings deeply
    // negative, brokerage untouched and compounding.
    expect(y2027.cashFlow.withdrawalsByAccount).toHaveLength(0);
    expect(y2027.accountBalances[extraSavings.id]).toBeLessThan(0);
    expect(y2027.accountBalances[brokerage.id]).toBeGreaterThan(3_000_000);
  });

  it("traceYear renders the year (smoke)", () => {
    const { scenario } = buildScenario(() => ({ splitOrder: [], drainOrder: [], drainSplitMode: "priority_fill" }));
    const result = projectScenario(scenario);
    const trace = traceYear(result, 2026);
    expect(trace).toContain("money-flow trace");
  });
});
