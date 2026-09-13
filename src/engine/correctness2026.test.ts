import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { resolveEvents } from "./resolveEvents";
import { expandOccurrences } from "./occurrences";
import { todaysDollarsAmount } from "./growth";
import { standardDeductionForYear } from "./taxTables";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";

/**
 * Regression tests for the September 2026 review's engine findings. Each
 * `describe` names the finding it guards; the numbers quoted in comments are
 * the ones the review reproduced before the fix.
 */

const person = (birthDate: string) => ({ id: nanoid(), name: "P", birthDate, retirementAge: 65, planningEndAge: 95 });

describe("basis is credited on every kind of inflow into a taxable account", () => {
  it("does not tax a transfer in and back out as gain", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 200_000 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 0, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash, brokerage],
      events: [
        { id: nanoid(), type: "custom_transfer", name: "In", startDate: "2026-02-01", amount: 100_000, fromAccountId: cash.id, toAccountId: brokerage.id, frequency: "one_time" },
        { id: nanoid(), type: "custom_transfer", name: "Out", startDate: "2026-06-01", amount: 100_000, fromAccountId: brokerage.id, toAccountId: cash.id, frequency: "one_time" },
      ],
    });
    const r = projectScenario(scenario);
    expect(r.years[0].cashFlow.capitalGainsRealized).toBeCloseTo(0, 0);
  });

  it("treats an inheritance deposited straight into a brokerage as basis", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 10_000 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 0, growthRatePct: 0, withdrawalPriority: 1 });
    const scenario = makeScenario({
      accounts: [cash, brokerage],
      incomeSources: [makeIncome({ name: "Inheritance", amount: 300_000, frequency: "one_time", startDate: "2026-01-15", category: "other", depositAccountId: brokerage.id })],
      expenses: [makeExpense({ amount: 20_000, frequency: "monthly", startDate: "2026-03-01" })],
      horizonEndDate: "2026-12-31",
    });
    const r = projectScenario(scenario);
    expect(r.years[0].cashFlow.capitalGainsRealized).toBeCloseTo(0, 0);
  });
});

describe("transfers are taxed by where they go", () => {
  const owner = person("1974-06-01"); // 52 in 2026
  const build = (toClass: "tax_free" | "tax_deferred" | "cash") => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 100_000 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 500_000, growthRatePct: 0, ownerId: owner.id });
    const dest = makeAccount({ class: toClass, name: "Dest", startingBalance: 0, growthRatePct: 0, ownerId: owner.id });
    const scenario = makeScenario({
      accounts: [cash, ira, dest],
      people: [owner],
      events: [{ id: nanoid(), type: "custom_transfer", name: "Move", startDate: "2026-03-01", amount: 50_000, fromAccountId: ira.id, toAccountId: dest.id, frequency: "one_time" }],
    });
    return { scenario, cash, ira, dest };
  };

  it("a Roth conversion is ordinary income, never penalized, with the tax paid from cash", () => {
    const { scenario, ira, dest, cash } = build("tax_free");
    const r = projectScenario(scenario);
    const y = r.years[0];
    expect(y.cashFlow.rothConversions).toBeCloseTo(50_000, 0);
    expect(y.cashFlow.federalTaxByComponent.find((c) => c.key === "early_withdrawal_penalty")).toBeUndefined();
    expect(y.cashFlow.federalTaxByComponent.find((c) => c.key === "roth_conversion")!.amount).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.kind === "early_withdrawal_penalty")).toBe(false);
    // The full amount lands in the Roth; the IRA lost exactly the amount; the tax came out of cash.
    expect(y.accountBalances[dest.id]).toBeCloseTo(50_000, 0);
    expect(y.accountBalances[ira.id]).toBeCloseTo(450_000, 0);
    expect(y.accountBalances[cash.id]).toBeLessThan(100_000);
    expect(r.ledger.some((e) => e.kind === "roth_conversion")).toBe(true);
  });

  it("a rollover between two tax-deferred accounts is not a taxable event", () => {
    const { scenario, ira, dest, cash } = build("tax_deferred");
    const r = projectScenario(scenario);
    const y = r.years[0];
    expect(y.cashFlow.federalTaxTotal).toBeCloseTo(0, 0);
    expect(y.accountBalances[dest.id]).toBeCloseTo(50_000, 0);
    expect(y.accountBalances[ira.id]).toBeCloseTo(450_000, 0);
    expect(y.accountBalances[cash.id]).toBeCloseTo(100_000, 0);
    expect(r.ledger.some((e) => e.kind === "rollover")).toBe(true);
  });

  it("a distribution to cash before 59½ is still taxed and penalized", () => {
    const { scenario } = build("cash");
    const r = projectScenario(scenario);
    expect(r.years[0].cashFlow.federalTaxByComponent.find((c) => c.key === "early_withdrawal_penalty")!.amount).toBeGreaterThan(0);
  });
});

describe("the 10% penalty is charged on the gross distribution", () => {
  it("charges 10% of gross, not of the net that reached cash", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 1_000_000, growthRatePct: 0, ownerId: owner.id, withdrawalPriority: 1 });
    const scenario = makeScenario({
      accounts: [cash, ira],
      people: [owner],
      expenses: [makeExpense({ amount: 6_000, frequency: "monthly" })],
    });
    const r = projectScenario(scenario);
    const y = r.years[0];
    const gross = y.cashFlow.withdrawalsByAccount.find((w) => w.id === ira.id)!.gross;
    const penalty = y.cashFlow.federalTaxByComponent.find((c) => c.key === "early_withdrawal_penalty")!.amount;
    expect(penalty / gross).toBeCloseTo(0.1, 3);
  });
});

describe("an RMD is held as the year's reserve, not swept and re-drawn", () => {
  it("keeps total IRA distributions at the RMD when the RMD exceeds spending", () => {
    const owner = person("1950-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 2_000_000, growthRatePct: 0, ownerId: owner.id, subjectToRMD: true, withdrawalPriority: 1 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 0, growthRatePct: 0, isSurplusTarget: true, surplusTargetPriority: 1 });
    const scenario = makeScenario({
      accounts: [cash, ira, brokerage],
      people: [owner],
      expenses: [makeExpense({ amount: 5_000, frequency: "monthly" })],
      horizonEndDate: "2027-12-31",
    });
    const r = projectScenario(scenario);
    const y2027 = r.years.find((y) => y.year === 2027)!;
    const rmd = y2027.cashFlow.rmdTotal;
    const gross = y2027.cashFlow.withdrawalsByAccount.find((w) => w.id === ira.id)!.gross;
    expect(rmd).toBeGreaterThan(60_000);
    // Gross distributions may exceed the RMD only by the withholding on it.
    expect(gross).toBeLessThan(rmd * 1.3);
    // And the unused reserve reached the brokerage by year end rather than idling in the hub.
    expect(y2027.accountBalances[cash.id]).toBeLessThan(1_000);
    expect(y2027.accountBalances[brokerage.id]).toBeGreaterThan(0);
  });
});

describe("withholding is sized at the effective rate", () => {
  it("leaves only a small true-up on a plain drawdown", () => {
    const owner = person("1960-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 2_000_000, growthRatePct: 0, ownerId: owner.id, withdrawalPriority: 1 });
    const scenario = makeScenario({
      accounts: [cash, ira],
      people: [owner],
      expenses: [makeExpense({ amount: 80_000 / 12, frequency: "monthly" })],
    });
    const r = projectScenario(scenario);
    const y = r.years[0];
    expect(Math.abs(y.cashFlow.taxSettlement)).toBeLessThan(y.cashFlow.federalTaxTotal * 0.15 + 50);
  });
});

describe("items dated before the plan start are not deflated", () => {
  it("a flat expense started years ago posts its today's-dollars amount", () => {
    expect(todaysDollarsAmount(2_000, "2026-01-01", "2020-01-01", "2026-06-01", 0.03, 0)).toBeCloseTo(2_000, 6);
  });
  it("a no-COLA pension in pay since 2015 posts its full amount", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [cash],
      incomeSources: [makeIncome({ name: "Pension", amount: 4_000, category: "pension", startDate: "2015-01-01", growthRatePct: 0 })],
      inflationRatePct: 0.03,
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].cashFlow.totalIncome).toBeCloseTo(48_000, 0);
  });
});

describe("mid-month dates", () => {
  it("a home sold on the 15th is off the books at that month's end", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash, home],
      events: [{ id: nanoid(), type: "sell_home", name: "Sell", startDate: "2026-12-15", realEstateAccountId: home.id, netProceeds: 480_000, sellingCostsPct: null, proceedsAccountId: null }],
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].accountBalances[home.id]).toBe(0);
    expect(r.years[0].netWorthNominal).toBeCloseTo(480_000, 0);
  });
  it("a drain window that opens on the 15th is active that month", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 100_000 });
    const scenario = makeScenario({
      accounts: [cash, savings],
      expenses: [makeExpense({ amount: 1_000, frequency: "monthly" })],
      moneyFlow: {
        splitOrder: [],
        drainOrder: [{ id: "d", accountId: savings.id, kind: "percent_of_remainder", amount: null, pct: 1, startDate: "2026-03-15", endDate: null, minBalance: null, minBalanceGrowthRatePct: null }],
      },
    });
    const r = forecastScenario(scenario);
    const march = r.months.find((m) => m.periodKey === "2026-03")!;
    expect(march.accountBalances[cash.id]).toBeCloseTo(0, 0);
  });
});

describe("the senior deduction stops after 2028", () => {
  it("is not applied in 2029 or later, and is not inflated while it lasts", () => {
    const people = [{ birthDate: "1958-01-01" }];
    const base2027 = standardDeductionForYear(people, "marriedFilingJointly", 2027, 0, 0);
    const base2029 = standardDeductionForYear(people, "marriedFilingJointly", 2029, 0, 0);
    expect(base2027 - base2029).toBeCloseTo(6_000, 0);
    const inflated2028 = standardDeductionForYear(people, "marriedFilingJointly", 2028, 0.03, 0);
    const inflatedNoSenior = standardDeductionForYear([{ birthDate: "1990-01-01" }], "marriedFilingJointly", 2028, 0.03, 0);
    expect(inflated2028 - inflatedNoSenior).toBeCloseTo(6_000 + 1_650 * Math.pow(1.03, 2), 0);
  });
});

describe("taking money from a liability is borrowing", () => {
  it("grows the card balance instead of shrinking it", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const card = makeAccount({ class: "credit_card", name: "Card", startingBalance: 5_000, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash, card],
      expenses: [makeExpense({ amount: 1_000, frequency: "monthly", paymentAccountId: card.id })],
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].accountBalances[card.id]).toBeCloseTo(17_000, 0);
  });
});

describe("Social Security taxability counts capital gains", () => {
  it("makes benefits taxable when gains push provisional income over the threshold", () => {
    const owner = person("1958-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 500_000, startingCostBasis: 100_000, growthRatePct: 0, withdrawalPriority: 1 });
    const scenario = makeScenario({
      accounts: [cash, brokerage],
      people: [owner],
      incomeSources: [makeIncome({ name: "SS", amount: 3_000, category: "social_security", ownerId: owner.id })],
      expenses: [makeExpense({ amount: 10_000, frequency: "monthly" })],
    });
    const r = projectScenario(scenario);
    expect(r.years[0].cashFlow.capitalGainsRealized).toBeGreaterThan(50_000);
    expect(r.years[0].cashFlow.taxableSocialSecurityAmount).toBeGreaterThan(20_000);
  });
});

describe("paycheck contributions need a paycheck", () => {
  it("stops a payroll-deducted contribution when the owner's salary ends", () => {
    const owner = person("1980-01-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const k401 = makeAccount({
      class: "tax_deferred", name: "401k", startingBalance: 0, growthRatePct: 0, ownerId: owner.id,
      contribution: { amount: 1_000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [cash, k401],
      people: [owner],
      incomeSources: [makeIncome({ name: "Salary", amount: 5_000, ownerId: owner.id, endDate: "2026-06-30" })],
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].accountBalances[k401.id]).toBeCloseTo(6_000, 0);
  });
  it("pauses it during a zero-multiplier career break", () => {
    const owner = person("1980-01-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const k401 = makeAccount({
      class: "tax_deferred", name: "401k", startingBalance: 0, growthRatePct: 0, ownerId: owner.id,
      contribution: { amount: 1_000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [cash, k401],
      people: [owner],
      incomeSources: [makeIncome({ name: "Salary", amount: 5_000, ownerId: owner.id, adjustments: [{ id: "a", startDate: "2026-04-01", endDate: "2026-06-30", multiplier: 0 }] })],
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].accountBalances[k401.id]).toBeCloseTo(9_000, 0);
  });
  it("keeps the old behavior when the plan has no salary entries at all", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const k401 = makeAccount({
      class: "tax_deferred", name: "401k", startingBalance: 0, growthRatePct: 0,
      contribution: { amount: 1_000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const r = forecastScenario(makeScenario({ accounts: [cash, k401] }));
    expect(r.years[0].accountBalances[k401.id]).toBeCloseTo(12_000, 0);
  });
});

describe("an already-running loan pays in the plan's first month", () => {
  it("makes twelve payments in year one", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 100_000 });
    const loan = makeAccount({
      class: "loan", name: "Car loan", startingBalance: 20_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 30_000, originationDate: "2024-03-01", annualInterestRatePct: 0.06, termMonths: 60 },
    });
    const r = forecastScenario(makeScenario({ accounts: [cash, loan] }));
    expect(r.ledger.filter((e) => e.kind === "mortgage_payment").length).toBe(12);
  });
});

describe("a salary that starts after retirement is left alone", () => {
  it("posts consulting income after the retire event", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [cash],
      people: [owner],
      incomeSources: [
        makeIncome({ name: "Salary", amount: 5_000, ownerId: owner.id }),
        makeIncome({ name: "Consulting", amount: 2_000, ownerId: owner.id, startDate: "2026-09-01" }),
      ],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-07-01", personId: owner.id }],
    });
    const r = forecastScenario(scenario);
    const y = r.years[0];
    expect(y.cashFlow.incomeByItem.find((i) => i.label === "Consulting")?.amount).toBeCloseTo(8_000, 0);
    expect(y.cashFlow.incomeByItem.find((i) => i.label === "Salary")?.amount).toBeCloseTo(30_000, 0);
  });
});

describe("small rules", () => {
  it("an interval still repeats a one-time item every N years (the convention the drawers rely on)", () => {
    expect(expandOccurrences("2026-01-01", null, "one_time", "2040-12-31", 7)).toEqual(["2026-01-01", "2033-01-01", "2040-01-01"]);
  });
  it("a retirement expense posts monthly, not as a December lump", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [cash],
      people: [owner],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-01-01", personId: owner.id, retirementExpense: { amount: 12_000, growthRatePct: 0, paymentAccountId: null, endDate: null } }],
    });
    const { postings } = resolveEvents(scenario);
    const posts = postings.filter((p) => p.sourceId.endsWith(":retirement_expense"));
    expect(posts).toHaveLength(12);
    expect(posts[0].amount).toBeCloseTo(-1_000, 6);
  });
  it("a home's running costs follow its scheduled appreciation change", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 1_000_000 });
    const home = makeAccount({
      class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.02, growthRateSchedule: [{ startDate: "2027-01-01", ratePct: 1.0 }],
    });
    const r = forecastScenario(makeScenario({ accounts: [cash, home], horizonEndDate: "2028-12-31" }));
    const costs2026 = r.years[0].cashFlow.expenseByItem.find((i) => i.id === `${home.id}:ownership_costs`)!.amount;
    const costs2028 = r.years[2].cashFlow.expenseByItem.find((i) => i.id === `${home.id}:ownership_costs`)!.amount;
    expect(costs2026).toBeCloseTo(10_000, 0);
    expect(costs2028).toBeGreaterThan(costs2026 * 2.5);
  });
});
