import { describe, it, expect } from "vitest";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { makeAccount, makeScenario, makeIncome, makeExpense } from "./testHelpers";
import type { ProjectionResult } from "@/domain";

/**
 * The no-overdraft rule: no asset account may ever hold a negative balance.
 * The motivating case is deliberately spending an account all the way down --
 * a 529 with a withdrawal rate set higher than it can sustain. Before this,
 * the account went negative and the growth step then COMPOUNDED that negative
 * balance into a runaway fictional debt. Now it stops at exactly $0 and the
 * unfunded remainder is charged to the spending hub, where the drain order
 * (the withdrawal routing) covers it like any other shortfall.
 *
 * The one deliberate exception, asserted at the bottom: the hub itself may go
 * negative once every routing source is exhausted -- that's the household
 * genuinely running out of money, and it has to stay visible.
 */

/** start + growth + deposits - withdrawals === end, for every account, every year. */
function expectRollforwardsBalance(result: ProjectionResult) {
  for (const year of result.years) {
    for (const rf of year.rollforwards) {
      expect(rf.startingBalance + rf.growth + rf.deposits - rf.withdrawals, `${rf.accountId} in ${year.year}`).toBeCloseTo(
        rf.endingBalance,
        2
      );
    }
  }
}

/** The documented cash-flow identity (see CashFlowPeriodRow.netCashFlow). */
function expectCashFlowReconciles(result: ProjectionResult) {
  for (const year of result.years) {
    const cf = year.cashFlow;
    const derived =
      cf.operatingCashFlow -
      cf.incomeTaxWithheldFromCash +
      cf.withdrawalsToCashNet +
      cf.taxSettlement -
      cf.afterTaxContributionTotal -
      cf.surplusRouted +
      cf.cashInterest +
      cf.otherAccountActivity;
    expect(derived, `year ${cf.year}`).toBeCloseTo(cf.netCashFlow, 2);
  }
}

/**
 * A 529 with $100k and a $60k/yr tuition bill paid straight out of it, so it
 * runs dry partway through the second year. A brokerage sits in the drain
 * order to pick up the rest; salary covers ordinary living costs so the only
 * thing testing the routing is the tuition overrun itself.
 */
function collegeScenario(overrides?: { plan529Growth?: number }) {
  const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
  const plan529 = makeAccount({
    class: "tax_free",
    name: "Kids 529",
    startingBalance: 100_000,
    growthRatePct: overrides?.plan529Growth ?? 0,
  });
  const brokerage = makeAccount({
    class: "taxable_investment",
    name: "Brokerage",
    startingBalance: 1_000_000,
    growthRatePct: 0,
    taxTreatment: "taxable",
    withdrawalPriority: 1, // the withdrawal routing (drain order)
  });
  const scenario = makeScenario({
    accounts: [hub, plan529, brokerage],
    startDate: "2026-01-01",
    horizonEndDate: "2030-12-31",
    inflationRatePct: 0,
    incomeSources: [makeIncome({ depositAccountId: hub.id, name: "Salary", amount: 5_000, frequency: "monthly" })],
    expenses: [
      makeExpense({ paymentAccountId: hub.id, name: "Living", amount: 5_000, frequency: "monthly", growthRatePct: 0 }),
      // The over-sized withdrawal rate: $60k/yr out of a $100k account.
      makeExpense({ paymentAccountId: plan529.id, name: "Tuition", amount: 5_000, frequency: "monthly", growthRatePct: 0 }),
    ],
  });
  return { scenario, hub, plan529, brokerage };
}

describe("no account can go negative", () => {
  it("empties an over-drawn 529 to exactly $0 instead of letting it go negative", () => {
    const { scenario, plan529 } = collegeScenario();
    const result = forecastScenario(scenario);

    const balances = result.years.map((y) => y.accountBalances[plan529.id]);
    // Year 1 draws $60k of the $100k; year 2 can only find the remaining $40k.
    expect(balances[0]).toBeCloseTo(40_000, 2);
    expect(balances[1]).toBeCloseTo(0, 2);
    for (const b of balances) expect(b).toBeGreaterThanOrEqual(-0.005);
  });

  it("keeps a depleted account at $0 rather than compounding the hole under its growth rate", () => {
    // The original bug: once negative, the monthly growth step multiplied the
    // negative balance, so the account fell further every month forever.
    const { scenario, plan529 } = collegeScenario({ plan529Growth: 0.07 });
    const result = forecastScenario(scenario);

    const final = result.years[result.years.length - 1].accountBalances[plan529.id];
    expect(final).toBeCloseTo(0, 2);
    // And it never dipped below zero on the way there, in any month.
    for (const month of result.months) expect(month.accountBalances[plan529.id]).toBeGreaterThanOrEqual(-0.005);
  });

  it("routes what the 529 can't cover to the next account in the withdrawal routing", () => {
    const { scenario, plan529, brokerage } = collegeScenario();
    const result = forecastScenario(scenario);

    // Five years of tuition = $300k. The 529 funds $100k of it; every dollar
    // after that has to come out of the brokerage via the drain order.
    const brokerageEnd = result.years[result.years.length - 1].accountBalances[brokerage.id];
    expect(brokerageEnd).toBeCloseTo(1_000_000 - 200_000, 0);

    // Withdrawals are attributed to the account they actually came from.
    const finalYear = result.years[result.years.length - 1].cashFlow;
    expect(finalYear.withdrawalsByAccount.find((w) => w.id === brokerage.id)?.net).toBeCloseTo(60_000, 0);
    expect(finalYear.withdrawalsByAccount.find((w) => w.id === plan529.id)).toBeUndefined();
  });

  it("logs the spill and flags the account as fully drawn down", () => {
    const { scenario, plan529 } = collegeScenario();
    const result = forecastScenario(scenario);

    const spills = result.ledger.filter((e) => e.kind === "shortfall_spill");
    expect(spills.length).toBeGreaterThan(0);
    expect(spills.every((e) => e.toAccountId === plan529.id)).toBe(true);

    const depleted = result.warnings.filter((w) => w.kind === "account_depleted");
    expect(depleted.length).toBeGreaterThan(0);
    expect(depleted[0].accountId).toBe(plan529.id);
    // Running out of a 529 on purpose is not an "insufficient funds" failure:
    // the routing covered the bill, so the plan itself is still solvent.
    expect(result.warnings.some((w) => w.kind === "insufficient_funds")).toBe(false);
  });

  it("conserves money -- the spilled tuition is still fully paid, and every statement still ties out", () => {
    const { scenario } = collegeScenario();
    const result = projectScenario(scenario);

    for (const year of result.years) {
      // $60k of tuition + $60k of living costs, every year, spill or no spill.
      expect(year.cashFlow.totalExpenses, `year ${year.year}`).toBeCloseTo(120_000, 0);
    }
    expectRollforwardsBalance(result);
    expectCashFlowReconciles(result);
  });

  it("drains a taxable account to exactly $0, tax included, not to negative", () => {
    // A withdrawal from a taxable account realizes capital-gains tax AT the
    // source, on top of the withdrawal -- so the draw has to be sized for
    // both, or the tax pushes the emptied account below zero.
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Small Brokerage",
      startingBalance: 50_000,
      startingCostBasis: 0, // all gain: the maximum possible tax drag
      growthRatePct: 0,
      taxTreatment: "taxable",
    });
    const backstop = makeAccount({
      class: "taxable_investment",
      name: "Big Brokerage",
      startingBalance: 2_000_000,
      growthRatePct: 0,
      taxTreatment: "taxable",
      withdrawalPriority: 1,
    });
    const scenario = makeScenario({
      accounts: [hub, brokerage, backstop],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
      inflationRatePct: 0,
      incomeSources: [makeIncome({ depositAccountId: hub.id, name: "Pension", amount: 8_000, frequency: "monthly", category: "pension" })],
      expenses: [makeExpense({ paymentAccountId: brokerage.id, name: "Big spend", amount: 10_000, frequency: "monthly", growthRatePct: 0 })],
    });
    const result = projectScenario(scenario);

    for (const month of result.months) expect(month.accountBalances[brokerage.id]).toBeGreaterThanOrEqual(-0.005);
    expect(result.years[result.years.length - 1].accountBalances[brokerage.id]).toBeCloseTo(0, 2);
    expectRollforwardsBalance(result);
    expectCashFlowReconciles(result);
  });

  it("still lets Extra Savings go negative when the whole plan runs out of money", () => {
    // The deliberate exception. Clamping the hub would make a failed plan
    // render as a flat $0 line, hiding the size of the hole in net worth.
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 10_000, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [hub],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
      inflationRatePct: 0,
      expenses: [makeExpense({ paymentAccountId: hub.id, name: "Living", amount: 5_000, frequency: "monthly", growthRatePct: 0 })],
    });
    const result = forecastScenario(scenario);

    expect(result.years[1].accountBalances[hub.id]).toBeCloseTo(10_000 - 120_000, 0);
    expect(result.warnings.some((w) => w.kind === "insufficient_funds" && w.accountId === hub.id)).toBe(true);
    // ...but the hole must not COMPOUND: an overdrawn balance earns no interest.
    const interestBearing = result.years[1].rollforwards.find((r) => r.accountId === hub.id);
    expect(interestBearing?.growth).toBe(0);
  });
});
