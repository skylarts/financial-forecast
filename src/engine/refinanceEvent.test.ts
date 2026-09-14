import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario } from "./forecastScenario";
import { makeAccount, makeScenario, makeIncome } from "./testHelpers";
import { computeMonthlyPayment } from "./amortization";
import type { ScenarioEvent } from "@/domain";

/** A 30-year, $400k mortgage at 7%, already running when the plan starts. */
function mortgage(rate = 0.07) {
  return makeAccount({
    class: "mortgage",
    category: "liability",
    name: "Mortgage",
    startingBalance: 400_000,
    growthRatePct: 0,
    loanTerms: { originalPrincipal: 400_000, originationDate: "2026-01-01", annualInterestRatePct: rate, termMonths: 360 },
  });
}

function refi(loanAccountId: string, over: Partial<Extract<ScenarioEvent, { type: "refinance" }>> = {}): ScenarioEvent {
  return {
    id: nanoid(),
    type: "refinance",
    name: "Refi",
    startDate: "2029-01-01",
    loanAccountId,
    annualInterestRatePct: 0.05,
    termMonths: 360,
    cashOutAmount: 0,
    cashOutAccountId: null,
    closingCosts: 0,
    closingCostsFinanced: true,
    extraPrincipalMonthly: null,
    ...over,
  };
}

function run(events: ScenarioEvent[], accounts: ReturnType<typeof makeAccount>[], horizon = "2032-12-31") {
  const checking = accounts.find((a) => a.isSpendingAccount)!;
  return forecastScenario(
    makeScenario({
      accounts,
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 8_000 })],
      events,
      startDate: "2026-01-01",
      horizonEndDate: horizon,
      inflationRatePct: 0,
    })
  );
}

describe("refinance", () => {
  it("keeps the balance and the account, and only changes what it costs from that month", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const plainLoan = mortgage();
    const withRefi = run([refi(loan.id)], [checking, loan]);
    const without = run([], [checking, plainLoan]);
    const bal = (r: typeof withRefi, y: number, id: string) => r.years.find((x) => x.year === y)!.accountBalances[id] ?? 0;

    // 2028 is before the refinance: identical either way.
    expect(bal(withRefi, 2028, loan.id)).toBeCloseTo(bal(without, 2028, plainLoan.id), 0);
    // After it, the 5% loan pays down faster than the 7% one (more of each
    // dollar is principal).
    expect(bal(withRefi, 2032, loan.id)).toBeLessThan(bal(without, 2032, plainLoan.id));
    // The account is the same account -- not a replacement.
    expect(withRefi.accounts.filter((a) => a.class === "mortgage")).toHaveLength(1);
  });

  it("re-sizes the payment off the balance at closing over the new term", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const r = run([refi(loan.id, { termMonths: 180 })], [checking, loan], "2029-12-31");
    // Balance at the end of 2028, the month before closing.
    const owed2028 = r.years.find((x) => x.year === 2028)!.accountBalances[loan.id]!;
    const expectedPayment = computeMonthlyPayment(owed2028, 0.05, 180);
    // A 15-year refi costs more per month than the 30-year it replaced.
    const paid2029 = r.years.find((x) => x.year === 2029)!.cashFlow.totalExpenses;
    const paid2028 = r.years.find((x) => x.year === 2028)!.cashFlow.totalExpenses;
    expect(paid2029).toBeGreaterThan(paid2028);
    // Roughly 12 payments at the re-sized figure (the closing month pays too).
    expect(paid2029).toBeCloseTo(expectedPayment * 12, -3);
  });

  it("cash out grows the debt and lands in the account you name", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const plainLoan = mortgage();
    const plain = run([refi(plainLoan.id)], [checking, plainLoan]);
    const cashed = run([refi(loan.id, { cashOutAmount: 50_000, cashOutAccountId: checking.id })], [checking, loan]);
    const y = (r: typeof plain) => r.years.find((x) => x.year === 2029)!;

    // Debt is ~$50k higher the year it closes...
    expect(y(cashed).accountBalances[loan.id]! - y(plain).accountBalances[plainLoan.id]!).toBeGreaterThan(48_000);
    // ...and the cash actually arrived (net of the bigger payments it caused).
    expect(y(cashed).accountBalances[checking.id]!).toBeGreaterThan(y(plain).accountBalances[checking.id]! + 45_000);
  });

  it("rolled-in closing costs grow the balance; paid-at-closing ones are an expense instead", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loanA = mortgage();
    const rolled = run([refi(loanA.id, { closingCosts: 6_000, closingCostsFinanced: true })], [checking, loanA]);
    const loanB = mortgage();
    const paid = run([refi(loanB.id, { closingCosts: 6_000, closingCostsFinanced: false })], [checking, loanB]);
    const y = (r: typeof rolled) => r.years.find((x) => x.year === 2029)!;

    // Rolled in: more debt. Paid at closing: less debt, but it shows as a cost.
    expect(y(rolled).accountBalances[loanA.id]!).toBeGreaterThan(y(paid).accountBalances[loanB.id]!);
    expect(y(paid).cashFlow.totalExpenses).toBeGreaterThan(y(rolled).cashFlow.totalExpenses);
  });

  it("reconciles the cash-flow statement every year, cash-out included", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const r = run([refi(loan.id, { cashOutAmount: 50_000, closingCosts: 6_000, closingCostsFinanced: false })], [checking, loan]);
    for (const year of r.years) {
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

  it("a second refinance replaces the first", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const onceLoan = mortgage();
    const once = run([refi(onceLoan.id)], [checking, onceLoan], "2034-12-31");
    const twice = run(
      [refi(loan.id), refi(loan.id, { startDate: "2031-01-01", annualInterestRatePct: 0.03 })],
      [checking, loan],
      "2034-12-31"
    );
    const at = (r: typeof once, y: number, id: string) => r.years.find((x) => x.year === y)!.accountBalances[id] ?? 0;
    // Through 2030 they agree; from 2031 the 3% loan pays down faster.
    expect(at(twice, 2030, loan.id)).toBeCloseTo(at(once, 2030, onceLoan.id), 0);
    expect(at(twice, 2032, loan.id)).toBeLessThan(at(once, 2032, onceLoan.id));
  });

  it("an excluded refinance changes nothing", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 300_000 });
    const loan = mortgage();
    const noneLoan = mortgage();
    const off = run([{ ...refi(loan.id), isExcluded: true }], [checking, loan]);
    const none = run([], [checking, noneLoan]);
    expect(off.years.find((x) => x.year === 2032)!.accountBalances[loan.id]).toBeCloseTo(
      none.years.find((x) => x.year === 2032)!.accountBalances[noneLoan.id]!,
      0
    );
  });
});
