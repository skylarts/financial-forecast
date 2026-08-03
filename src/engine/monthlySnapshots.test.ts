import { describe, expect, it } from "vitest";
import { MONTHLY_DETAIL_YEARS, projectScenario } from "./forecastScenario";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";
import type { CashFlowPeriodRow, PeriodSnapshot, Scenario } from "@/domain";

/**
 * A deliberately busy scenario: salary and a pension landing on the hub, a
 * mix of monthly and ANNUAL expenses (so months are genuinely lumpy rather
 * than 1/12 of the year), a mortgage amortizing, a surplus split into a
 * brokerage, a tax-deferred account subject to RMDs feeding the drain
 * cascade, and inflation switched on so the deflators actually differ
 * period to period.
 */
function busyScenario(): Scenario {
  const person = { id: "p1", name: "Test Person", birthDate: "1953-04-10", retirementAge: 65, planningEndAge: 95 };
  const brokerage = makeAccount({
    id: "brokerage",
    name: "Brokerage",
    class: "taxable_investment",
    startingBalance: 250_000,
    startingCostBasis: 150_000,
    growthRatePct: 0.06,
    isSurplusTarget: true,
    surplusTargetPriority: 1,
    withdrawalPriority: 1,
  });
  const ira = makeAccount({
    id: "ira",
    name: "Traditional IRA",
    class: "tax_deferred",
    startingBalance: 600_000,
    growthRatePct: 0.05,
    ownerId: person.id,
    subjectToRMD: true,
    withdrawalPriority: 2,
  });
  const home = makeAccount({
    id: "home",
    name: "Home",
    class: "real_estate",
    startingBalance: 500_000,
    propertyGrowthRatePct: 0.03,
    linkedLiabilityId: "mortgage",
  });
  const mortgage = makeAccount({
    id: "mortgage",
    name: "Mortgage",
    class: "mortgage",
    startingBalance: 300_000,
    loanTerms: {
      originalPrincipal: 300_000,
      originationDate: "2020-06-01",
      annualInterestRatePct: 0.055,
      termMonths: 360,
      extraPrincipalMonthly: 0,
      linkedAssetId: "home",
    },
  });

  return makeScenario({
    accounts: [brokerage, ira, home, mortgage],
    people: [person],
    startDate: "2026-01-01",
    horizonEndDate: "2029-12-31",
    inflationRatePct: 0.025,
    incomeSources: [
      makeIncome({ id: "salary", name: "Salary", amount: 7_000, frequency: "monthly", grossAmount: 9_000, endDate: "2027-06-30" }),
      makeIncome({ id: "pension", name: "Pension", amount: 2_500, frequency: "monthly", category: "pension", ownerId: person.id }),
      makeIncome({ id: "bonus", name: "Annual bonus", amount: 20_000, frequency: "annual", startDate: "2026-03-01" }),
    ],
    expenses: [
      makeExpense({ id: "living", name: "Living costs", amount: 6_500, frequency: "monthly" }),
      // An annual bill is the whole point of a monthly view: it lands in ONE
      // month, not smeared across twelve.
      makeExpense({ id: "proptax", name: "Property tax", amount: 12_000, frequency: "annual", startDate: "2026-10-01" }),
      makeExpense({ id: "bigbuy", name: "New roof", amount: 30_000, frequency: "one_time", startDate: "2027-05-01" }),
    ],
  });
}

/** The monthly snapshots belonging to a given calendar year, in order. */
function monthsOfYear(months: PeriodSnapshot[], year: number): PeriodSnapshot[] {
  return months.filter((m) => m.year === year);
}

const sumOf = (rows: PeriodSnapshot[], get: (c: CashFlowPeriodRow) => number) =>
  rows.reduce((s, m) => s + get(m.cashFlow), 0);

describe("monthly snapshots", () => {
  const projection = projectScenario(busyScenario());
  const { years, months } = projection;

  it("covers every month of the horizon when it fits inside the detail window", () => {
    // 2026-2029 is 48 months, well inside the 5-year window.
    expect(months).toHaveLength(48);
    expect(months[0].periodKey).toBe("2026-01");
    expect(months[0].periodLabel).toBe("Jan '26");
    expect(months[months.length - 1].periodKey).toBe("2029-12");
    expect(months.every((m) => m.granularity === "month")).toBe(true);
    expect(years.every((y) => y.granularity === "year")).toBe(true);
  });

  it("bounds the monthly window even on a long horizon", () => {
    const long = busyScenario();
    long.settings.horizonEndDate = "2075-12-31";
    const result = projectScenario(long);
    expect(result.years.length).toBe(50);
    expect(result.months).toHaveLength(MONTHLY_DETAIL_YEARS * 12);
    expect(result.months[result.months.length - 1].periodKey).toBe(`${2026 + MONTHLY_DETAIL_YEARS - 1}-12`);
  });

  it("gives a full 5-year window even when the plan starts mid-year", () => {
    // A plan starting Aug 2026 (e.g. a blank start date resolved to "today")
    // should still get MONTHLY_DETAIL_YEARS * 12 months, not just however
    // many happen to fall before the next Dec 31st four calendar years out.
    const midYear = busyScenario();
    midYear.settings.startDate = "2026-08-03";
    midYear.settings.horizonEndDate = "2075-12-31";
    const result = projectScenario(midYear);
    expect(result.months).toHaveLength(MONTHLY_DETAIL_YEARS * 12);
    expect(result.months[0].periodKey).toBe("2026-08");
    expect(result.months[result.months.length - 1].periodKey).toBe("2031-07");
  });

  // The core guarantee: monthly rows are the same numbers as the annual row,
  // just sliced finer. If this drifts, the monthly views are lying.
  describe.each(years.map((y) => y.year))("year %i rolls up exactly", (year) => {
    const annual = years.find((y) => y.year === year)!;
    const yearMonths = monthsOfYear(months, year);

    it("has twelve months", () => {
      expect(yearMonths).toHaveLength(12);
    });

    it.each([
      ["totalIncome", (c: CashFlowPeriodRow) => c.totalIncome],
      ["totalExpenses", (c: CashFlowPeriodRow) => c.totalExpenses],
      ["operatingCashFlow", (c: CashFlowPeriodRow) => c.operatingCashFlow],
      ["netCashFlow", (c: CashFlowPeriodRow) => c.netCashFlow],
      ["surplusRouted", (c: CashFlowPeriodRow) => c.surplusRouted],
      ["withdrawalsToCashNet", (c: CashFlowPeriodRow) => c.withdrawalsToCashNet],
      ["rmdTotal", (c: CashFlowPeriodRow) => c.rmdTotal],
      ["withdrawalTaxes", (c: CashFlowPeriodRow) => c.withdrawalTaxes],
      ["taxSettlement", (c: CashFlowPeriodRow) => c.taxSettlement],
      ["incomeTaxWithheldFromCash", (c: CashFlowPeriodRow) => c.incomeTaxWithheldFromCash],
      ["cashInterest", (c: CashFlowPeriodRow) => c.cashInterest],
      ["otherAccountActivity", (c: CashFlowPeriodRow) => c.otherAccountActivity],
      ["afterTaxContributionTotal", (c: CashFlowPeriodRow) => c.afterTaxContributionTotal],
      ["capitalGainsRealized", (c: CashFlowPeriodRow) => c.capitalGainsRealized],
      ["grossSocialSecurity", (c: CashFlowPeriodRow) => c.grossSocialSecurity],
      // The exact bracket-computed bill is annual by nature and lands wholly
      // on December -- so it still sums across the twelve months to the year.
      ["federalTaxTotal", (c: CashFlowPeriodRow) => c.federalTaxTotal],
    ])("sums %s to the annual figure", (_label, get) => {
      expect(sumOf(yearMonths, get)).toBeCloseTo(get(annual.cashFlow), 4);
    });

    it("sums each income and expense line item to its annual amount", () => {
      for (const key of ["incomeByItem", "expenseByItem"] as const) {
        for (const annualItem of annual.cashFlow[key]) {
          const monthlyTotal = yearMonths.reduce(
            (s, m) => s + (m.cashFlow[key].find((i) => i.id === annualItem.id)?.amount ?? 0),
            0
          );
          expect(monthlyTotal, `${key} / ${annualItem.label}`).toBeCloseTo(annualItem.amount, 4);
        }
      }
    });

    it("sums each account's gross withdrawals to the annual figure", () => {
      for (const annualItem of annual.cashFlow.withdrawalsByAccount) {
        const monthlyTotal = yearMonths.reduce(
          (s, m) => s + (m.cashFlow.withdrawalsByAccount.find((w) => w.id === annualItem.id)?.gross ?? 0),
          0
        );
        expect(monthlyTotal, annualItem.label).toBeCloseTo(annualItem.gross, 4);
      }
    });

    it("ends December on the annual closing balances and net worth", () => {
      const december = yearMonths[11];
      expect(december.netWorthNominal).toBeCloseTo(annual.netWorthNominal, 4);
      expect(december.totalAssetsNominal).toBeCloseTo(annual.totalAssetsNominal, 4);
      expect(december.totalLiabilitiesNominal).toBeCloseTo(annual.totalLiabilitiesNominal, 4);
      for (const [accountId, balance] of Object.entries(annual.accountBalances)) {
        expect(december.accountBalances[accountId], accountId).toBeCloseTo(balance, 4);
      }
    });

    it("chains each month's rollforward from the previous month's closing balance", () => {
      for (const account of projection.accounts) {
        for (let i = 0; i < yearMonths.length; i++) {
          const roll = yearMonths[i].rollforwards.find((r) => r.accountId === account.id)!;
          // start + growth + deposits - withdrawals = end, every month.
          expect(
            roll.startingBalance + roll.growth + roll.deposits - roll.withdrawals,
            `${account.name} ${yearMonths[i].periodKey}`
          ).toBeCloseTo(roll.endingBalance, 4);
          if (i > 0) {
            const prior = yearMonths[i - 1].rollforwards.find((r) => r.accountId === account.id)!;
            expect(roll.startingBalance, `${account.name} ${yearMonths[i].periodKey} opening`).toBeCloseTo(
              prior.endingBalance,
              4
            );
          }
        }
      }
    });
  });

  it("puts an annual expense in its own month rather than smearing it", () => {
    const propTaxIn = (m: PeriodSnapshot) => m.cashFlow.expenseByItem.find((i) => i.id === "proptax")?.amount ?? 0;
    const annualPropTax = years.find((y) => y.year === 2026)!.cashFlow.expenseByItem.find((i) => i.id === "proptax")!.amount;
    // The whole year's property tax lands in the one month it's billed...
    expect(propTaxIn(months.find((m) => m.periodKey === "2026-10")!)).toBeCloseTo(annualPropTax, 4);
    // ...and nowhere else.
    for (const m of monthsOfYear(months, 2026)) {
      if (m.periodKey !== "2026-10") expect(propTaxIn(m), m.periodKey).toBe(0);
    }
  });

  it("reports the exact tax bill only in December", () => {
    for (const m of monthsOfYear(months, 2026)) {
      if (m.periodKey === "2026-12") expect(m.cashFlow.federalTaxTotal).toBeGreaterThan(0);
      else expect(m.cashFlow.federalTaxTotal).toBe(0);
    }
  });

  it("withholds tax at the source month by month, not only in December", () => {
    // Withholding is taken as each withdrawal happens, so it must appear in
    // months other than December -- that's what makes the monthly Account
    // Activity figures meaningful.
    const withheldOutsideDecember = monthsOfYear(months, 2029)
      .filter((m) => !m.periodKey.endsWith("-12"))
      .reduce((s, m) => s + m.cashFlow.withdrawalTaxes, 0);
    expect(withheldOutsideDecember).toBeGreaterThan(0);
  });

  it("deflates monthly balances and flows to their own point in time", () => {
    const jan = months.find((m) => m.periodKey === "2027-01")!;
    const dec = months.find((m) => m.periodKey === "2027-12")!;
    // Later months carry more cumulative inflation than earlier ones...
    expect(dec.inflationDeflator).toBeGreaterThan(jan.inflationDeflator);
    // ...and each month's flow deflator sits below its own closing-balance
    // deflator, since flows average to mid-month.
    for (const m of months) {
      expect(m.flowInflationDeflator).toBeLessThan(m.inflationDeflator);
    }
    // December's balance deflator should match the annual row's (both are
    // measured at the same year-end instant, within a day of rounding).
    const annual2027 = years.find((y) => y.year === 2027)!;
    expect(dec.inflationDeflator).toBeCloseTo(annual2027.inflationDeflator, 3);
  });
});
