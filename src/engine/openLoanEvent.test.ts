import { describe, it, expect } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario } from "./forecastScenario";
import { makeAccount, makeScenario, makeIncome } from "./testHelpers";
import type { ScenarioEvent } from "@/domain";

/** The loan account an open_loan event owns: created by src/lib/openLoan.ts at
 *  save time, so the engine only ever sees a finished account. */
function loanAccount(startDate: string, principal: number) {
  return makeAccount({
    class: "loan",
    category: "liability",
    name: "Car loan",
    startDate,
    startingBalance: principal,
    growthRatePct: 0,
    loanTerms: {
      originalPrincipal: principal,
      originationDate: startDate,
      annualInterestRatePct: 0.06,
      termMonths: 60,
    },
  });
}

function openLoanEvent(loanAccountId: string, startDate: string, principal: number, proceedsAccountId: string | null): ScenarioEvent {
  return { id: nanoid(), type: "open_loan", name: "Car loan", startDate, loanAccountId, loanKind: "fixed", principal, proceedsAccountId };
}

describe("open_loan", () => {
  it("books the debt on its start date and nothing before it", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    const loan = loanAccount("2030-01-01", 40_000);
    const result = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, null)],
        startDate: "2026-01-01",
        horizonEndDate: "2036-12-31",
        inflationRatePct: 0,
      })
    );
    const at = (year: number) => result.years.find((y) => y.year === year)!;

    expect(at(2029).accountBalances[loan.id] ?? 0).toBe(0);
    // 40k at 6% over 60 months: about 33.5k still owed after the first year.
    expect(at(2030).accountBalances[loan.id]).toBeGreaterThan(30_000);
    expect(at(2030).accountBalances[loan.id]).toBeLessThan(36_000);
    // And it pays itself off by the end of the term rather than running forever.
    expect(at(2035).accountBalances[loan.id] ?? 0).toBeLessThan(1);
  });

  it("credits the borrowed money when it lands in an account", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    const loan = loanAccount("2030-01-01", 40_000);
    const withProceeds = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, checking.id)],
        startDate: "2026-01-01",
        horizonEndDate: "2030-12-31",
        inflationRatePct: 0,
      })
    );
    const withoutProceeds = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, null)],
        startDate: "2026-01-01",
        horizonEndDate: "2030-12-31",
        inflationRatePct: 0,
      })
    );
    const cash = (r: typeof withProceeds) => r.years.find((y) => y.year === 2030)!.accountBalances[checking.id]!;

    // The only difference between the two plans is where the money went.
    expect(cash(withProceeds) - cash(withoutProceeds)).toBeCloseTo(40_000, 0);
  });

  it("borrowing is not income -- it never shows up as money earned", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    const loan = loanAccount("2030-01-01", 40_000);
    const result = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, checking.id)],
        startDate: "2026-01-01",
        horizonEndDate: "2030-12-31",
        inflationRatePct: 0,
      })
    );
    const y2030 = result.years.find((y) => y.year === 2030)!;
    const y2029 = result.years.find((y) => y.year === 2029)!;
    // Same salary both years: the $40k must not inflate income or the tax bill.
    expect(y2030.cashFlow.totalIncome).toBeCloseTo(y2029.cashFlow.totalIncome, 0);
    expect(y2030.cashFlow.federalTaxTotal).toBeCloseTo(y2029.cashFlow.federalTaxTotal, 0);
  });

  it("the cash-flow statement still reconciles the year the loan lands", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    const loan = loanAccount("2030-01-01", 40_000);
    const result = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, checking.id)],
        startDate: "2026-01-01",
        horizonEndDate: "2032-12-31",
        inflationRatePct: 0,
      })
    );
    for (const year of result.years) {
      const cf = year.cashFlow;
      const explained =
        cf.operatingCashFlow +
        cf.withdrawalsToCashNet -
        cf.afterTaxContributionTotal -
        cf.surplusRouted +
        cf.cashInterest +
        cf.otherAccountActivity;
      expect(explained, `year ${cf.year}`).toBeCloseTo(cf.netCashFlow, 2);
    }
  });

  it("inflates the amount borrowed to the date it is actually taken out", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    // The account carries the inflated snapshot openLoan.ts computes; the
    // event keeps today's dollars. Both must agree, or the cash credited and
    // the debt booked would differ.
    const inflated = 40_000 * Math.pow(1.03, 4);
    const loan = loanAccount("2030-01-01", inflated);
    const result = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, checking.id)],
        startDate: "2026-01-01",
        horizonEndDate: "2030-12-31",
        inflationRatePct: 0.03,
      })
    );
    const y2030 = result.years.find((y) => y.year === 2030)!;
    const baseline = forecastScenario(
      makeScenario({
        accounts: [checking, loan],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [openLoanEvent(loan.id, "2030-01-01", 40_000, null)],
        startDate: "2026-01-01",
        horizonEndDate: "2030-12-31",
        inflationRatePct: 0.03,
      })
    ).years.find((y) => y.year === 2030)!;

    expect(y2030.accountBalances[checking.id]! - baseline.accountBalances[checking.id]!).toBeCloseTo(inflated, 0);
  });
});

describe("open_loan as a HELOC", () => {
  function heloc(startDate: string, drawn: number, homeId: string) {
    return makeAccount({
      class: "loan",
      category: "liability",
      name: "HELOC",
      startDate,
      startingBalance: drawn,
      growthRatePct: 0,
      loanTerms: {
        originalPrincipal: drawn,
        originationDate: startDate,
        annualInterestRatePct: 0.06,
        termMonths: 240, // 20-year repayment
        interestOnlyMonths: 24, // 2-year draw period, kept short so the test can see both phases
        linkedAssetId: homeId,
      },
    });
  }

  it("stands still through the draw period, then amortizes what was drawn", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 200_000 });
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0 });
    const line = heloc("2027-01-01", 50_000, home.id);
    const result = forecastScenario(
      makeScenario({
        accounts: [checking, home, line],
        incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
        events: [{ id: nanoid(), type: "open_loan", name: "HELOC", startDate: "2027-01-01", loanAccountId: line.id, loanKind: "heloc", principal: 50_000, proceedsAccountId: checking.id }],
        startDate: "2026-01-01",
        horizonEndDate: "2032-12-31",
        inflationRatePct: 0,
      })
    );
    const at = (y: number) => result.years.find((r) => r.year === y)!;
    // Draw period (2027, 2028): interest only, balance exactly unchanged.
    expect(at(2027).accountBalances[line.id]).toBeCloseTo(50_000, 0);
    expect(at(2028).accountBalances[line.id]).toBeCloseTo(50_000, 0);
    // Repayment starts 2029: the balance finally falls.
    expect(at(2029).accountBalances[line.id]).toBeLessThan(50_000);
    expect(at(2029).accountBalances[line.id]).toBeGreaterThan(47_000);
    // Interest-only year costs less than an amortizing year.
    const cost = (y: number) => at(y - 1).accountBalances[checking.id]! + 60_000 - at(y).accountBalances[checking.id]!;
    expect(cost(2028)).toBeCloseTo(50_000 * 0.06, -1); // ~$3,000 of interest
    expect(cost(2030)).toBeGreaterThan(cost(2028));
  });

  it("is paid off out of the proceeds when the home it is secured by sells", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000 });
    const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 500_000, growthRatePct: 0 });
    const line = heloc("2027-01-01", 50_000, home.id);
    const base = {
      accounts: [checking, home, line],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
      startDate: "2026-01-01",
      horizonEndDate: "2031-12-31",
      inflationRatePct: 0,
    };
    const withSale = forecastScenario(
      makeScenario({
        ...base,
        events: [
          { id: nanoid(), type: "open_loan", name: "HELOC", startDate: "2027-01-01", loanAccountId: line.id, loanKind: "heloc", principal: 50_000, proceedsAccountId: null },
          { id: nanoid(), type: "sell_home", name: "Sell", startDate: "2028-06-01", realEstateAccountId: home.id, sellingCostsPct: 0, netProceeds: 0, proceedsAccountId: checking.id },
        ],
      })
    );
    const y = withSale.years.find((r) => r.year === 2028)!;
    // Both the home and the line are gone the year of the sale...
    expect(y.accountBalances[home.id] ?? 0).toBe(0);
    expect(y.accountBalances[line.id] ?? 0).toBe(0);
    // ...and the cash credited is the equity NET of the line, not the full value.
    const sale = withSale.ledger.find((l) => l.kind === "home_sale")!;
    expect(sale.amount).toBeCloseTo(500_000 - 50_000, 0);
  });
});
