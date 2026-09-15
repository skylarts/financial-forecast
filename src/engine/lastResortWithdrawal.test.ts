import { describe, expect, it } from "vitest";
import { projectScenario } from "./forecastScenario";
import { makeScenario, makeAccount, makeExpense } from "./testHelpers";
import { firstShortfallYear, firstImprovisedYear, holdsThroughLabel } from "./planHealth";

const HORIZON = { startDate: "2026-01-01", horizonEndDate: "2027-12-31", inflationRatePct: 0 } as const;
const hub = () => makeAccount({ class: "cash", name: "Hub", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
const bill = () => makeExpense({ name: "Living", amount: 2_000, growthRatePct: 0 });

describe("the last-resort tier", () => {
  it("reaches an account the drain order never listed, instead of going negative", () => {
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", taxTreatment: "taxable", startingBalance: 500_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({ accounts: [hub(), brokerage], expenses: [bill()], moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON }));
    expect(firstShortfallYear(r)).toBeNull();
    expect(firstImprovisedYear(r)).toBe(2026);
    expect(r.years[0].accountBalances[brokerage.id]).toBeCloseTo(500_000 - 24_000, 0);
  });

  it("still reports a real shortfall when there is genuinely nothing left", () => {
    const r = projectScenario(makeScenario({ accounts: [hub()], expenses: [bill()], moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON }));
    expect(firstShortfallYear(r)).toBe(2026);
    expect(holdsThroughLabel(r)).toBe("Runs short in 2026");
  });

  it("spends cash before selling, and leaves tax-free money for last", () => {
    const cash = makeAccount({ class: "cash", name: "Savings", startingBalance: 10_000, growthRatePct: 0 });
    const taxable = makeAccount({ class: "taxable_investment", name: "Brokerage", taxTreatment: "taxable", startingBalance: 10_000, growthRatePct: 0 });
    const roth = makeAccount({ class: "tax_free", name: "Roth", taxTreatment: "tax_free", startingBalance: 500_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({ accounts: [hub(), cash, taxable, roth], expenses: [bill()], moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON }));
    const y1 = r.years[0];
    // $24k of bills: the $10k of cash goes first, then the $10k taxable, and
    // only the last $4k comes out of the Roth.
    expect(y1.accountBalances[cash.id]).toBeCloseTo(0, 0);
    expect(y1.accountBalances[taxable.id]).toBeCloseTo(0, 0);
    expect(y1.accountBalances[roth.id]).toBeCloseTo(500_000 - 4_000, 0);
  });

  it("leaves a home, a 529 and an HSA alone -- they have rules this model doesn't carry", () => {
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 800_000, growthRatePct: 0 });
    const c529 = makeAccount({ class: "education_529", name: "529", taxTreatment: "tax_free", startingBalance: 200_000, growthRatePct: 0 });
    const hsa = makeAccount({ class: "hsa", name: "HSA", taxTreatment: "tax_free", startingBalance: 200_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({ accounts: [hub(), home, c529, hsa], expenses: [bill()], moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON }));
    expect(firstShortfallYear(r)).toBe(2026);
    expect(r.years[0].accountBalances[home.id]).toBeCloseTo(800_000, 0);
    expect(r.years[0].accountBalances[c529.id]).toBeCloseTo(200_000, 0);
    expect(r.years[0].accountBalances[hsa.id]).toBeCloseTo(200_000, 0);
  });

  it("charges the early-withdrawal penalty on an improvised raid, like any other", () => {
    const owner = { id: "p1", name: "A", birthDate: "1990-01-01", retirementAge: 60, planningEndAge: 90 };
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", taxTreatment: "tax_deferred", ownerId: owner.id, startingBalance: 500_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({
      accounts: [hub(), ira], people: [owner], expenses: [bill()],
      moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON,
    }));
    // Age 36 in 2026, so the raid is penalised -- the plan should show it.
    expect(r.warnings.some((w) => w.kind === "early_withdrawal_penalty")).toBe(true);
    expect(firstImprovisedYear(r)).toBe(2026);
  });

  it("does not fire at all when the drain order covers the bills as written", () => {
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 500_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({
      accounts: [hub(), savings], expenses: [bill()],
      moneyFlow: { splitOrder: [], drainOrder: [{ id: "d1", accountId: savings.id, kind: "percent_of_remainder", amount: null, pct: 1, startDate: null, endDate: null, minBalance: null, minBalanceGrowthRatePct: null }] },
      ...HORIZON,
    }));
    expect(firstImprovisedYear(r)).toBeNull();
    expect(holdsThroughLabel(r)).toBe("End of plan");
  });

  it("reads as 'Improvises from' rather than 'Runs short' when the money was there", () => {
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", taxTreatment: "taxable", startingBalance: 500_000, growthRatePct: 0 });
    const r = projectScenario(makeScenario({ accounts: [hub(), brokerage], expenses: [bill()], moneyFlow: { splitOrder: [], drainOrder: [] }, ...HORIZON }));
    expect(holdsThroughLabel(r)).toBe("Improvises from 2026");
  });
});
