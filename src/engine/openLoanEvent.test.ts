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
  return { id: nanoid(), type: "open_loan", name: "Car loan", startDate, loanAccountId, principal, proceedsAccountId };
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
