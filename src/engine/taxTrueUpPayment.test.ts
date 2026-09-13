import { describe, expect, it } from "vitest";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { makeAccount, makeExpense, makeScenario } from "./testHelpers";

/**
 * Regression: the year-end tax true-up posts to the hub in December AFTER
 * the deficit cascade (step 6) has already run for the month. A PAYMENT
 * (under-withholding) therefore used to sit on Extra Savings unfunded, so a
 * retired household living on tax-deferred draws closed every single year
 * with Extra Savings negative by exactly that year's true-up -- with no
 * warning, since the negative-balance check (step 7) had also already run.
 * January's cascade quietly covered it, then the next December re-created
 * it, which read to a user as "my extra cash goes negative and never
 * recovers".
 */
function underWithheldScenario() {
  const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
  const ira = makeAccount({
    class: "tax_deferred", name: "Trad IRA", taxTreatment: "tax_deferred",
    startingBalance: 2_000_000, growthRatePct: 0, withdrawalPriority: 1,
  });
  const spend = makeExpense({ amount: 120_000 / 12, frequency: "monthly", growthRatePct: 0 });
  return makeScenario({
    accounts: [hub, ira],
    expenses: [spend],
    startDate: "2026-01-01",
    horizonEndDate: "2026-12-31",
    filingStatus: "marriedFilingJointly",
  });
}

describe("year-end tax true-up payment is funded from the drain order", () => {
  it("leaves Extra Savings at $0 in December and books the draw that paid the bill", () => {
    const scenario = underWithheldScenario();
    const hub = scenario.accounts.find((a) => a.isExtraSavings)!;
    const ira = scenario.accounts.find((a) => a.name === "Trad IRA")!;
    // Force a real under-withholding: withhold at 5% against a bracket bill
    // that is well above that on ~$135k of gross draws.
    const result = forecastScenario(
      scenario,
      new Map([[2026, { ordinaryMarginalRate: 0.22, ordinaryWithholdingRate: 0.05, ltcgMarginalRate: 0.15, ssTaxableFraction: 0.5 }]])
    );
    const y = result.years[0];

    // The payment is real money, not a rounding artifact...
    expect(y.cashFlow.taxSettlement).toBeLessThan(-1_000);
    // ...and it was paid, not left as a hole in the hub.
    expect(y.accountBalances[hub.id]).toBeCloseTo(0, 2);
    // The IRA funded it: a December deficit draw follows the settlement entry.
    const december = result.ledger.filter((e) => e.date === "2026-12-01");
    const settlementAt = december.findIndex((e) => e.kind === "tax_settlement");
    expect(settlementAt).toBeGreaterThanOrEqual(0);
    expect(
      december.slice(settlementAt + 1).some((e) => e.kind === "deficit_withdrawal" && e.accountId === ira.id && e.toAccountId === hub.id)
    ).toBe(true);
    // No false alarm: the drain order covered it, so nothing runs negative.
    expect(result.warnings.some((w) => w.kind === "insufficient_funds")).toBe(false);
  });

  it("still lands the household's cash tax exactly on the bracket bill", () => {
    // The draw that pays the bill is itself taxable income for the year --
    // the settlement loop must recompute the bill until withheld and owed agree.
    const scenario = underWithheldScenario();
    const result = forecastScenario(
      scenario,
      new Map([[2026, { ordinaryMarginalRate: 0.22, ordinaryWithholdingRate: 0.05, ltcgMarginalRate: 0.15, ssTaxableFraction: 0.5 }]])
    );
    const cf = result.years[0].cashFlow;
    expect(cf.withdrawalTaxes - cf.taxSettlement).toBeCloseTo(cf.federalTaxTotal, 2);
  });

  it("converges through the full projection with no year closing negative", () => {
    const scenario = underWithheldScenario();
    const hub = scenario.accounts.find((a) => a.isExtraSavings)!;
    const result = projectScenario(scenario);
    for (const y of result.years) {
      expect(y.accountBalances[hub.id]).toBeGreaterThanOrEqual(-0.005);
      expect(y.cashFlow.withdrawalTaxes - y.cashFlow.taxSettlement).toBeCloseTo(y.cashFlow.federalTaxTotal, 2);
    }
  });

  it("warns when the drain order cannot fund the payment", () => {
    // An IRA too small to cover both the year's spending and the bill: the
    // hub ends the year negative, and now says so.
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const ira = makeAccount({
      class: "tax_deferred", name: "Trad IRA", taxTreatment: "tax_deferred",
      startingBalance: 126_000, growthRatePct: 0, withdrawalPriority: 1,
    });
    const spend = makeExpense({ amount: 120_000 / 12, frequency: "monthly", growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [hub, ira],
      expenses: [spend],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
      filingStatus: "marriedFilingJointly",
    });
    const result = forecastScenario(
      scenario,
      new Map([[2026, { ordinaryMarginalRate: 0.22, ordinaryWithholdingRate: 0.05, ltcgMarginalRate: 0.15, ssTaxableFraction: 0.5 }]])
    );
    const y = result.years[0];
    expect(y.cashFlow.taxSettlement).toBeLessThan(-100);
    expect(y.accountBalances[hub.id]).toBeLessThan(-0.005);
    expect(result.warnings.some((w) => w.kind === "insufficient_funds" && w.accountId === hub.id)).toBe(true);
  });
});
