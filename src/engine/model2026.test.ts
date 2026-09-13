import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { filingStatusForYear, deathDateOf } from "./household";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";

/** Guards the September 2026 model changes: real events, death rules, HSA/529. */

const person = (birthDate: string, planningEndAge = 95) => ({ id: nanoid(), name: "P", birthDate, retirementAge: 65, planningEndAge });

describe("Roth conversion event", () => {
  it("converts a fixed amount every year with the tax paid from cash", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 100_000 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 500_000, growthRatePct: 0, ownerId: owner.id });
    const roth = makeAccount({ class: "tax_free", name: "Roth", startingBalance: 0, growthRatePct: 0, ownerId: owner.id });
    const scenario = makeScenario({
      accounts: [cash, ira, roth],
      people: [owner],
      events: [{ id: nanoid(), type: "roth_conversion", name: "Ladder", startDate: "2026-06-01", fromAccountId: ira.id, toAccountId: roth.id, amount: 40_000, fillToBracketRate: null, frequency: "annual", taxSource: "cash", growthRatePct: 0 }],
      horizonEndDate: "2027-12-31",
    });
    const r = projectScenario(scenario);
    expect(r.years[0].cashFlow.rothConversions).toBeCloseTo(40_000, 0);
    expect(r.years[1].cashFlow.rothConversions).toBeCloseTo(40_000, 0);
    expect(r.years[1].accountBalances[roth.id]).toBeCloseTo(80_000, 0);
    expect(r.years[1].accountBalances[ira.id]).toBeCloseTo(420_000, 0);
    expect(r.years[0].accountBalances[cash.id]).toBeLessThan(100_000);
    expect(r.warnings.some((w) => w.kind === "early_withdrawal_penalty")).toBe(false);
  });

  it("withholds the tax from the conversion when asked", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 100_000 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 500_000, growthRatePct: 0, ownerId: owner.id });
    const roth = makeAccount({ class: "tax_free", name: "Roth", startingBalance: 0, growthRatePct: 0, ownerId: owner.id });
    const scenario = makeScenario({
      accounts: [cash, ira, roth],
      people: [owner],
      events: [{ id: nanoid(), type: "roth_conversion", name: "Once", startDate: "2026-06-01", fromAccountId: ira.id, toAccountId: roth.id, amount: 40_000, fillToBracketRate: null, frequency: "one_time", taxSource: "withhold" }],
    });
    const r = projectScenario(scenario);
    expect(r.years[0].accountBalances[roth.id]).toBeLessThan(40_000);
    expect(r.years[0].accountBalances[roth.id]).toBeGreaterThan(30_000);
    expect(r.years[0].accountBalances[cash.id]).toBeCloseTo(100_000 + r.years[0].cashFlow.taxSettlement, 0);
  });

  it("fills ordinary income up to the top of the 12% bracket each December", () => {
    const owner = person("1960-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 200_000 });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 1_000_000, growthRatePct: 0, ownerId: owner.id });
    const roth = makeAccount({ class: "tax_free", name: "Roth", startingBalance: 0, growthRatePct: 0, ownerId: owner.id });
    const scenario = makeScenario({
      accounts: [cash, ira, roth],
      people: [owner],
      filingStatus: "marriedFilingJointly",
      events: [{ id: nanoid(), type: "roth_conversion", name: "Fill", startDate: "2026-01-01", fromAccountId: ira.id, toAccountId: roth.id, amount: null, fillToBracketRate: 0.12, frequency: "annual", taxSource: "cash" }],
    });
    const r = projectScenario(scenario);
    const y = r.years[0];
    // MFJ 2026: the 12% bracket tops out at 100,800 of taxable income. With no
    // other income the whole deduction is room too: 32,200 standard + 1,650
    // (one spouse is 65+) + 6,000 (the 2025-2028 senior deduction) = 39,850,
    // so the conversion is 140,650 and taxable income lands exactly on the top.
    expect(y.cashFlow.ordinaryTaxableIncome).toBeCloseTo(100_800, -1);
    expect(y.cashFlow.rothConversions).toBeCloseTo(140_650, -1);
  });
});

describe("rollover and pay-off events", () => {
  it("rolls the whole balance between tax-deferred accounts with no tax", () => {
    const owner = person("1974-06-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 10_000 });
    const k401 = makeAccount({ class: "tax_deferred", name: "401k", startingBalance: 250_000, growthRatePct: 0, ownerId: owner.id });
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 0, growthRatePct: 0, ownerId: owner.id });
    const scenario = makeScenario({
      accounts: [cash, k401, ira],
      people: [owner],
      events: [{ id: nanoid(), type: "rollover", name: "Roll", startDate: "2026-04-01", fromAccountId: k401.id, toAccountId: ira.id, amount: null }],
    });
    const r = projectScenario(scenario);
    expect(r.years[0].accountBalances[k401.id]).toBe(0);
    expect(r.years[0].accountBalances[ira.id]).toBeCloseTo(250_000, 0);
    expect(r.years[0].cashFlow.federalTaxTotal).toBeCloseTo(0, 0);
    expect(r.years[0].accountBalances[cash.id]).toBeCloseTo(10_000, 0);
  });

  it("pays off whatever is left on a mortgage from savings", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 300_000, growthRatePct: 0 });
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0 });
    const mortgage = makeAccount({
      class: "mortgage", name: "Mortgage", startingBalance: 200_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 300_000, originationDate: "2020-01-01", annualInterestRatePct: 0.05, termMonths: 360, linkedAssetId: home.id },
    });
    const scenario = makeScenario({
      accounts: [cash, savings, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
      incomeSources: [makeIncome({ amount: 5_000 })],
      events: [{ id: nanoid(), type: "pay_off_loan", name: "Pay off", startDate: "2026-07-01", loanAccountId: mortgage.id, fromAccountId: savings.id, amount: null }],
    });
    const r = forecastScenario(scenario);
    const y = r.years[0];
    expect(y.accountBalances[mortgage.id]).toBe(0);
    expect(y.accountBalances[savings.id]).toBeGreaterThan(100_000);
    expect(y.accountBalances[savings.id]).toBeLessThan(105_000);
    // No more payments after the payoff: six months of payments, not twelve.
    expect(r.ledger.filter((e) => e.kind === "mortgage_payment").length).toBe(6);
  });
});

describe("a person's modelled death", () => {
  const spouseA = () => ({ id: nanoid(), name: "A", birthDate: "1960-01-01", retirementAge: 65, planningEndAge: 70 });
  const spouseB = () => ({ id: nanoid(), name: "B", birthDate: "1962-01-01", retirementAge: 65, planningEndAge: 95 });

  it("stops the deceased's salary, keeps the larger Social Security, and continues a pension at its survivor share", () => {
    const a = spouseA();
    const b = spouseB();
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [cash],
      people: [a, b],
      incomeSources: [
        makeIncome({ name: "A salary", amount: 4_000, ownerId: a.id }),
        makeIncome({ name: "A SS", amount: 3_000, category: "social_security", ownerId: a.id }),
        makeIncome({ name: "B SS", amount: 1_500, category: "social_security", ownerId: b.id }),
        makeIncome({ name: "A pension", amount: 2_000, category: "pension", ownerId: a.id, survivorPct: 0.5 }),
      ],
      filingStatus: "marriedFilingJointly",
      startDate: "2029-01-01",
      horizonEndDate: "2031-12-31",
    });
    const r = forecastScenario(scenario);
    // A dies 2030-01-01. 2029 is a full year for everything.
    const y2029 = r.years.find((y) => y.year === 2029)!;
    const y2031 = r.years.find((y) => y.year === 2031)!;
    const item = (y: typeof y2029, label: string) => y.cashFlow.incomeByItem.find((i) => i.label === label)?.amount ?? 0;
    expect(item(y2029, "A salary")).toBeCloseTo(48_000, 0);
    expect(item(y2031, "A salary")).toBe(0);
    // The larger benefit (A's) continues to the survivor; the smaller (B's) stops.
    expect(item(y2031, "A SS")).toBeCloseTo(36_000, 0);
    expect(item(y2031, "B SS")).toBe(0);
    // The pension continues at half.
    expect(item(y2031, "A pension")).toBeCloseTo(12_000, 0);
    expect(deathDateOf(a)).toBe("2030-01-01");
  });

  it("switches a married household to single brackets the year after the first death", () => {
    const a = spouseA();
    const b = spouseB();
    expect(filingStatusForYear([a, b], "marriedFilingJointly", 2030)).toBe("marriedFilingJointly");
    expect(filingStatusForYear([a, b], "marriedFilingJointly", 2031)).toBe("single");
    expect(filingStatusForYear([a, b], "single", 2031)).toBe("single");
  });

  it("passes an account to the survivor, whose age then governs RMDs and penalties", () => {
    const a = spouseA(); // dies at 70, before RMD age
    const b = { ...spouseB(), birthDate: "1950-01-01" }; // survivor already past RMD age
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({ class: "tax_deferred", name: "A IRA", startingBalance: 1_000_000, growthRatePct: 0, ownerId: a.id, subjectToRMD: true });
    const scenario = makeScenario({
      accounts: [cash, ira],
      people: [a, b],
      startDate: "2029-01-01",
      horizonEndDate: "2031-12-31",
    });
    const r = projectScenario(scenario);
    expect(r.years.find((y) => y.year === 2029)!.cashFlow.rmdTotal).toBe(0);
    expect(r.years.find((y) => y.year === 2031)!.cashFlow.rmdTotal).toBeGreaterThan(0);
  });
});

describe("HSA and 529 accounts", () => {
  it("withdraw tax-free and take paycheck contributions", () => {
    const owner = person("1980-01-01");
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true, startingBalance: 0 });
    const hsa = makeAccount({
      class: "hsa", name: "HSA", startingBalance: 20_000, growthRatePct: 0, ownerId: owner.id,
      contribution: { amount: 300, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [cash, hsa],
      people: [owner],
      incomeSources: [makeIncome({ amount: 5_000, ownerId: owner.id })],
      expenses: [makeExpense({ name: "Medical", amount: 1_000, frequency: "monthly", category: "healthcare", paymentAccountId: hsa.id })],
    });
    const r = projectScenario(scenario);
    const y = r.years[0];
    expect(y.cashFlow.federalTaxTotal).toBeCloseTo(0, 0);
    expect(y.accountBalances[hsa.id]).toBeCloseTo(20_000 + 3_600 - 12_000, 0);
    expect(y.cashFlow.afterTaxContributionTotal).toBe(0);
  });
});
