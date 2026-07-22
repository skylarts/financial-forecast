import { describe, it, expect } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { makeAccount, makeIncome, makeExpense, makeScenario } from "./testHelpers";
import { mockScenario } from "@/lib/mockScenario";
import { elapsedYears } from "./dateMath";
import { growthAdjustedAmount } from "./growth";

describe("forecastScenario -- account growth", () => {
  it("compounds monthly, skipping the account's creation month (matches the prior engine's proven rule)", () => {
    const account = makeAccount({ class: "cash", startingBalance: 10_000, growthRatePct: 0.04 });
    const scenario = makeScenario({ accounts: [account], horizonEndDate: "2027-12-31" });
    const result = forecastScenario(scenario);

    const monthlyRate = Math.pow(1.04, 1 / 12) - 1;
    const expected = 10_000 * Math.pow(1 + monthlyRate, 23); // 24 months, first skipped
    expect(result.years[1].accountBalances[account.id]).toBeCloseTo(expected, 0);
  });

});

describe("forecastScenario -- income, expenses, and surplus routing", () => {
  it("routes positive net cash flow to the priority-1 surplus target", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 3000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    expect(year.cashFlow.totalIncome).toBeCloseTo(60_000, 0);
    expect(year.cashFlow.totalExpenses).toBeCloseTo(36_000, 0);
    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(24_000, 0);
  });

  it("fills a capped priority-1 target then spills the overflow to priority-2", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const emergencyFund = makeAccount({
      class: "cash",
      name: "Emergency Fund",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
      maxBalance: 10_000,
      maxBalanceGrowthRatePct: 0, // hold the cap flat for a clean assertion
    });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 2,
    });
    const scenario = makeScenario({
      accounts: [checking, emergencyFund, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 3000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // $24k of surplus: $10k fills the capped emergency fund, the other $14k
    // spills to the brokerage -- which used to never be funded.
    expect(year.accountBalances[emergencyFund.id]).toBeCloseTo(10_000, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(14_000, 0);
    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
  });

  it("grows the cap over time so a later year can hold more", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const emergencyFund = makeAccount({
      class: "cash",
      name: "Emergency Fund",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
      maxBalance: 10_000,
      maxBalanceGrowthRatePct: 0.10, // +10%/yr for an easy-to-read assertion
    });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 2,
    });
    const scenario = makeScenario({
      accounts: [checking, emergencyFund, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 4500 })], // $6k surplus/yr
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!;

    // Year 1 fills to 10k. Year 2's cap is 11k, so it accepts 1k more before spilling.
    expect(y2027.accountBalances[emergencyFund.id]).toBeCloseTo(11_000, 0);
  });

  it("spills a custom transfer that overshoots a capped target onto the next priority", () => {
    const source = makeAccount({ class: "cash", name: "Windfall", startingBalance: 50_000 });
    const emergencyFund = makeAccount({
      class: "cash",
      name: "Emergency Fund",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
      maxBalance: 30_000,
      maxBalanceGrowthRatePct: 0,
    });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 2,
    });
    const scenario = makeScenario({
      accounts: [source, emergencyFund, brokerage],
      events: [
        {
          id: nanoid(),
          type: "custom_transfer",
          name: "Move windfall to emergency fund",
          startDate: "2026-06-01",
          amount: 50_000,
          fromAccountId: source.id,
          toAccountId: emergencyFund.id,
          frequency: "one_time",
        },
      ],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // $50k transferred in, but the fund is capped at $30k, so $20k spills to the brokerage.
    expect(year.accountBalances[emergencyFund.id]).toBeCloseTo(30_000, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(20_000, 0);
    expect(year.accountBalances[source.id]).toBeCloseTo(0, 0);
  });

  it("Extra Savings has no configurable floor -- the whole surplus sweeps, not just the excess above some target", () => {
    const checking = makeAccount({
      class: "cash",
      name: "Checking",
      isSpendingAccount: true,
      // targetCashBalance is a legacy hint with no home anymore -- Extra
      // Savings has no user-configurable floor/ceiling (see testHelpers.ts).
      targetCashBalance: 10_000,
    });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 3000 })], // $24k/yr surplus
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // No floor to keep money back -- all $24k of surplus sweeps out.
    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(24_000, 0);
  });

  it("routes surplus by fixed percentages, cascading -- each stop takes its share of what's left, not of the original total", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const savings = makeAccount({ class: "cash", name: "Savings", isSurplusTarget: true });
    const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", isSurplusTarget: true });
    const scenario = makeScenario({
      accounts: [checking, savings, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 3000 })], // $24k/yr surplus
      surplusRoutingRule: {
        mode: "fixed_split",
        splits: [
          { accountId: savings.id, pct: 0.75 },
          { accountId: brokerage.id, pct: 0.25 },
        ],
      },
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // $24k surplus: savings takes 75% ($18k) first; brokerage takes 25% of
    // what's LEFT ($6k), i.e. $1.5k -- not 25% of the original $24k. The
    // $4.5k neither stop claims stays in Extra Savings.
    expect(year.accountBalances[savings.id]).toBeCloseTo(18_000, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(1_500, 0);
    expect(year.accountBalances[checking.id]).toBeCloseTo(4_500, 0);
  });

  it("spills income deposited straight into a capped target onto the next priority", () => {
    const emergencyFund = makeAccount({
      class: "cash",
      name: "Emergency Fund",
      isSurplusTarget: true,
      surplusTargetPriority: 1,
      maxBalance: 30_000,
      maxBalanceGrowthRatePct: 0,
    });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      isSurplusTarget: true,
      surplusTargetPriority: 2,
    });
    const scenario = makeScenario({
      accounts: [emergencyFund, brokerage],
      incomeSources: [makeIncome({ depositAccountId: emergencyFund.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // $60k of income lands in the fund; $30k stays (the cap), $30k spills to the brokerage.
    expect(year.accountBalances[emergencyFund.id]).toBeCloseTo(30_000, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(30_000, 0);
  });
});

describe("forecastScenario -- deficit cascade", () => {
  it("covers a shortfall from the lowest withdrawal-priority account", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const savings = makeAccount({
      class: "cash",
      name: "Savings",
      withdrawalPriority: 1,
      startingBalance: 50_000,
    });
    const scenario = makeScenario({
      accounts: [checking, savings],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 2000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[savings.id]).toBeCloseTo(50_000 - 24_000, 0);
    // No RMDs/direct-payments here, so all withdrawals-to-cash is the deficit draw.
    expect(year.cashFlow.withdrawalsToCashNet).toBeCloseTo(24_000, 0);
    const savingsWithdrawal = year.cashFlow.withdrawalsByAccount.find((w) => w.id === savings.id)!;
    expect(savingsWithdrawal.net).toBeCloseTo(24_000, 0);
    expect(savingsWithdrawal.tax).toBeCloseTo(0, 0);
  });

  it("emits an insufficient_funds warning when every source is exhausted", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [checking],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 1000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    expect(result.warnings.some((w) => w.kind === "insufficient_funds" && w.accountId === checking.id)).toBe(true);
  });
});

describe("forecastScenario -- RMDs", () => {
  it("forces the correct RMD amount using the IRS divisor for age 73", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      ownerId: personId,
      subjectToRMD: true,
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      people: [{ id: personId, name: "Retiree", birthDate: "1953-01-01", retirementAge: 65, planningEndAge: 95 }],
      startDate: "2025-01-01",
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);

    // Turns 73 in 2026 (born 1953) -> RMD fires in January 2026, using the
    // 2025 year-end balance (500,000, since growthRatePct=0 and no other flows).
    const rmdEvents = result.ledger.filter((e) => e.kind === "rmd");
    expect(rmdEvents).toHaveLength(1);
    expect(rmdEvents[0].amount).toBeCloseTo(500_000 / 26.5, 2);
    expect(result.years[1].cashFlow.rmdTotal).toBeCloseTo(500_000 / 26.5, 2);
  });
});

describe("forecastScenario -- retirement", () => {
  it("stops salary income at the retire event's date", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const scenario = makeScenario({
      accounts: [checking],
      people: [{ id: personId, name: "Worker", birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 }],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000, ownerId: personId, category: "salary" })],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-07-01", personId }],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    expect(result.years[0].cashFlow.totalIncome).toBeCloseTo(5000 * 6, 0); // Jan-Jun only
  });
});

describe("forecastScenario -- buy_home", () => {
  it("creates a real estate asset and a linked, amortizing mortgage liability", () => {
    const result = forecastScenario(mockScenario);
    const buyEvent = mockScenario.events.find((e) => e.type === "buy_home");
    expect(buyEvent).toBeDefined();
    if (!buyEvent || buyEvent.type !== "buy_home") throw new Error("unreachable");

    const purchaseYear = Number(buyEvent.startDate.slice(0, 4));
    const purchaseSnapshot = result.years.find((y) => y.year === purchaseYear)!;
    // Purchase price and down payment are entered in today's dollars and
    // inflate from plan start to the purchase date, same factor for both.
    const inflationFactor = growthAdjustedAmount(
      1,
      elapsedYears(mockScenario.settings.startDate, buyEvent.startDate),
      mockScenario.settings.inflationRatePct
    );
    const principal = (buyEvent.purchasePrice - buyEvent.downPaymentAmount) * inflationFactor;

    // The mortgage's opening principal is its starting balance for the year it's
    // created; the rollforward must still balance:
    // start + growth + deposits - withdrawals = end.
    const mortgageRollforward = purchaseSnapshot.rollforwards.find(
      (r) => Math.abs(r.startingBalance - principal) < 1
    );
    expect(mortgageRollforward).toBeDefined();
    expect(mortgageRollforward!.startingBalance).toBeCloseTo(principal, 0);
    const computedEnding =
      mortgageRollforward!.startingBalance +
      mortgageRollforward!.growth +
      mortgageRollforward!.deposits -
      mortgageRollforward!.withdrawals;
    expect(mortgageRollforward!.endingBalance).toBeCloseTo(computedEnding, 6);
    expect(mortgageRollforward!.endingBalance).toBeLessThan(principal); // paid down within the purchase year

    // The mortgage should keep amortizing down in subsequent years too.
    const nextYearRollforward = result.years
      .find((y) => y.year === purchaseYear + 1)!
      .rollforwards.find((r) => r.accountId === mortgageRollforward!.accountId)!;
    expect(nextYearRollforward.startingBalance).toBeCloseTo(mortgageRollforward!.endingBalance, 2);
    expect(nextYearRollforward.endingBalance).toBeLessThan(mortgageRollforward!.endingBalance);
  });

  it("stops charging the mortgage payment once the loan is fully paid off", () => {
    // Regression: the loan BALANCE correctly stopped changing once paid off
    // (amortizeMonth caps principal at the remaining balance), but the cash
    // charge to the payer account and the ledger entry weren't gated on that
    // at all -- the fixed payment kept being deducted and logged as an
    // expense every month for the rest of the plan, even decades after
    // payoff. A short (24-month) term keeps this test fast.
    const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 200_000, growthRatePct: 0 });
    // The home a buy_home event purchases is now a real, permanent Account
    // (and its mortgage a real, permanent Account too) -- see
    // src/lib/buyHome.ts -- built directly here rather than embedded in the
    // event, which now just records the purchase transaction.
    const home = makeAccount({
      class: "real_estate",
      name: "Home",
      startingBalance: 100_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      startDate: "2026-01-01",
    });
    const mortgage = makeAccount({
      class: "mortgage",
      name: "Home Mortgage",
      startingBalance: 80_000,
      growthRatePct: 0,
      startDate: "2026-01-01",
      loanTerms: {
        originalPrincipal: 80_000,
        originationDate: "2026-01-01",
        annualInterestRatePct: 0.06,
        termMonths: 24,
        linkedAssetId: home.id,
      },
    });
    const scenario = makeScenario({
      accounts: [checking, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
      events: [
        {
          id: nanoid(),
          type: "buy_home",
          name: "Buy a home",
          startDate: "2026-01-01",
          purchasePrice: 100_000,
          downPaymentAmount: 20_000,
          downPaymentFromAccountId: checking.id,
          realEstateAccountId: home.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
    });
    const result = forecastScenario(scenario);
    const mortgageAccount = result.accounts.find((a) => a.class === "mortgage")!;

    // Originates Jan 2026 (no payment that month); 24 monthly payments Feb
    // 2026 through Jan 2028, then nothing.
    const payments = result.ledger.filter((e) => e.kind === "mortgage_payment");
    expect(payments).toHaveLength(24);
    expect(payments[0].date).toBe("2026-02-01");
    expect(payments[23].date).toBe("2028-01-01");

    const y2027 = result.years.find((y) => y.year === 2027)!;
    expect(y2027.cashFlow.expenseByItem.some((i) => i.id === mortgageAccount.id)).toBe(true); // still paying

    const y2029 = result.years.find((y) => y.year === 2029)!;
    expect(y2029.accountBalances[mortgageAccount.id]).toBeCloseTo(0, 6); // loan paid off
    expect(y2029.cashFlow.expenseByItem.some((i) => i.id === mortgageAccount.id)).toBe(false); // no phantom payments
  });

  it("extra monthly principal pays the mortgage off ahead of schedule", () => {
    const makeBuy = (extraPrincipalMonthly?: number) => {
      const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 500_000, growthRatePct: 0 });
      const home = makeAccount({
        class: "real_estate",
        name: "Home",
        startingBalance: 200_000,
        growthRatePct: 0,
        propertyGrowthRatePct: 0,
        startDate: "2026-01-01",
      });
      const mortgage = makeAccount({
        class: "mortgage",
        name: "Home Mortgage",
        startingBalance: 160_000,
        growthRatePct: 0,
        startDate: "2026-01-01",
        loanTerms: {
          originalPrincipal: 160_000,
          originationDate: "2026-01-01",
          annualInterestRatePct: 0.06,
          termMonths: 360,
          extraPrincipalMonthly,
          linkedAssetId: home.id,
        },
      });
      return makeScenario({
        accounts: [checking, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
        events: [
          {
            id: nanoid(),
            type: "buy_home",
            name: "Buy a home",
            startDate: "2026-01-01",
            purchasePrice: 200_000,
            downPaymentAmount: 40_000,
            downPaymentFromAccountId: checking.id,
            realEstateAccountId: home.id,
          },
        ],
        startDate: "2026-01-01",
        horizonEndDate: "2056-12-31", // room for all 360 scheduled payments (first is Feb 2026)
      });
    };

    const basePayments = forecastScenario(makeBuy()).ledger.filter((e) => e.kind === "mortgage_payment");
    const extraPayments = forecastScenario(makeBuy(1_000)).ledger.filter((e) => e.kind === "mortgage_payment");

    // A 30-year loan runs the full 360 months without extra principal; $1k/mo
    // extra retires it well before the horizon, so there are strictly fewer.
    expect(basePayments).toHaveLength(360);
    expect(extraPayments.length).toBeLessThan(360);
    // The final payment never overshoots the remaining balance.
    expect(extraPayments[extraPayments.length - 1].amount).toBeGreaterThan(0);
  });

  it("charges property tax, home insurance, and maintenance as one rolled-up share of the home's value", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Buy a home",
      startingBalance: 500_000,
      growthRatePct: 0, // flat value keeps the yearly cost exact
      propertyGrowthRatePct: 0,
      startDate: "2026-01-01",
      propertyTaxRatePct: 0.01,
      homeInsuranceRatePct: 0.005,
      maintenanceRatePct: 0.01,
    });
    const scenario = makeScenario({
      accounts: [checking, home],
      events: [
        {
          id: nanoid(),
          type: "buy_home",
          name: "Buy a home",
          startDate: "2026-01-01",
          purchasePrice: 500_000,
          downPaymentAmount: 500_000, // cash purchase (down payment == price)
          downPaymentFromAccountId: checking.id,
          realEstateAccountId: home.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!; // full year, home value flat at 500k
    // Tax, insurance, and maintenance share one sourceId (see resolveEvents.ts's
    // pushOwnershipCosts) so the Cash Flow tab shows a single combined line.
    const ownershipItems = y2027.cashFlow.expenseByItem.filter((i) => i.id === `${home.id}:ownership_costs`);
    expect(ownershipItems).toHaveLength(1);
    expect(ownershipItems[0].amount).toBeCloseTo(12_500, 0); // 1% + 0.5% + 1% of $500k
  });

  it("replaceHousingExpenses stops any category=housing expense the day before the purchase closes", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const rent = makeExpense({ category: "housing", paymentAccountId: checking.id, amount: 2_000, growthRatePct: 0 });
    const groceries = makeExpense({ category: "food", paymentAccountId: checking.id, amount: 500, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Buy a home",
      startingBalance: 400_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      startDate: "2026-07-01",
    });
    const scenario = makeScenario({
      accounts: [checking, home],
      expenses: [rent, groceries],
      events: [
        {
          id: nanoid(),
          type: "buy_home",
          name: "Buy a home",
          startDate: "2026-07-01",
          purchasePrice: 400_000,
          downPaymentAmount: 400_000,
          downPaymentFromAccountId: checking.id,
          realEstateAccountId: home.id,
          replaceHousingExpenses: true,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!; // full year after the purchase
    expect(y2027.cashFlow.expenseByItem.some((i) => i.id === rent.id)).toBe(false); // rent stopped
    expect(y2027.cashFlow.expenseByItem.some((i) => i.id === groceries.id)).toBe(true); // untouched, wrong category
  });

  it("charges property tax, insurance, and maintenance on a directly-entered real_estate account (the 'already own' flow)", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Home",
      startingBalance: 300_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.01,
      homeInsuranceRatePct: 0.005,
      maintenanceRatePct: 0.01,
    });
    const scenario = makeScenario({
      accounts: [checking, home],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!;
    // Tax, insurance, and maintenance share one sourceId (see resolveEvents.ts's
    // pushOwnershipCosts) so the Cash Flow tab shows a single combined line.
    const ownershipCosts = y2027.cashFlow.expenseByItem.find((i) => i.id === `${home.id}:ownership_costs`);
    expect(ownershipCosts?.amount).toBeCloseTo(7_500, 0); // 1% + 0.5% + 1% of $300k
  });

  it("replaceHousingExpenses also retires an already-owned home's mortgage and its ongoing costs", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Old Home",
      startingBalance: 300_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.01,
    });
    const mortgage = makeAccount({
      class: "mortgage",
      name: "Old Mortgage",
      startingBalance: 150_000,
      growthRatePct: 0,
      loanTerms: {
        originalPrincipal: 150_000,
        originationDate: "2026-01-01",
        annualInterestRatePct: 0.06,
        termMonths: 360,
        linkedAssetId: home.id,
      },
    });
    const newHome = makeAccount({
      class: "real_estate",
      name: "Buy a new home",
      startingBalance: 500_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      startDate: "2027-06-01",
    });
    const scenario = makeScenario({
      accounts: [checking, { ...home, linkedLiabilityId: mortgage.id }, mortgage, newHome],
      events: [
        {
          id: nanoid(),
          type: "buy_home",
          name: "Buy a new home",
          startDate: "2027-06-01",
          purchasePrice: 500_000,
          downPaymentAmount: 500_000,
          downPaymentFromAccountId: checking.id,
          realEstateAccountId: newHome.id,
          replaceHousingExpenses: true,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);

    // Old mortgage stops taking payments once the new home closes.
    const y2028 = result.years.find((y) => y.year === 2028)!; // full year after the new purchase
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgage.id)).toBe(false);
    // Balance freezes wherever it was -- no payoff/sale modeled, just no more payments.
    const y2027 = result.years.find((y) => y.year === 2027)!;
    expect(y2028.accountBalances[mortgage.id]).toBeCloseTo(y2027.accountBalances[mortgage.id], 2);

    // Old home's ongoing property tax stops too.
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === `${home.id}:ownership_costs`)).toBe(false);
  });
});

describe("forecastScenario -- sell_home", () => {
  it("credits net proceeds and fully retires the home's asset and mortgage (not just frozen)", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Home",
      startingBalance: 400_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.01,
    });
    const mortgage = makeAccount({
      class: "mortgage",
      name: "Mortgage",
      startingBalance: 200_000,
      growthRatePct: 0,
      loanTerms: {
        originalPrincipal: 200_000,
        originationDate: "2026-01-01",
        annualInterestRatePct: 0.06,
        termMonths: 360,
        linkedAssetId: home.id,
      },
    });
    const scenario = makeScenario({
      accounts: [checking, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
      events: [
        {
          id: nanoid(),
          type: "sell_home",
          name: "Sell the house",
          startDate: "2027-06-01",
          realEstateAccountId: home.id,
          netProceeds: 175_000,
          proceedsAccountId: checking.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);

    // Proceeds landed straight in checking (a hub-touching transfer, same
    // bucket a buy_home down payment uses).
    const saleYear = result.years.find((y) => y.year === 2027)!;
    expect(saleYear.cashFlow.otherAccountActivity).toBeCloseTo(175_000, 0);

    // Both accounts fully zeroed (not just frozen) from the sale onward.
    const y2028 = result.years.find((y) => y.year === 2028)!;
    expect(y2028.accountBalances[home.id]).toBeCloseTo(0, 2);
    expect(y2028.accountBalances[mortgage.id]).toBeCloseTo(0, 2);

    // No more mortgage payments or property tax after the sale.
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgage.id)).toBe(false);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === `${home.id}:ownership_costs`)).toBe(false);
  });

  it("selling one of two homes leaves the other's mortgage and costs untouched", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const homeA = makeAccount({ class: "real_estate", name: "Home A", startingBalance: 300_000, growthRatePct: 0, propertyGrowthRatePct: 0, propertyTaxRatePct: 0.01 });
    const mortgageA = makeAccount({
      class: "mortgage",
      name: "Mortgage A",
      startingBalance: 150_000,
      growthRatePct: 0,
      loanTerms: { originalPrincipal: 150_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: homeA.id },
    });
    const homeB = makeAccount({ class: "real_estate", name: "Home B", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0, propertyTaxRatePct: 0.01 });
    const mortgageB = makeAccount({
      class: "mortgage",
      name: "Mortgage B",
      startingBalance: 300_000,
      growthRatePct: 0,
      loanTerms: { originalPrincipal: 300_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: homeB.id },
    });
    const scenario = makeScenario({
      accounts: [
        checking,
        { ...homeA, linkedLiabilityId: mortgageA.id },
        mortgageA,
        { ...homeB, linkedLiabilityId: mortgageB.id },
        mortgageB,
      ],
      events: [
        {
          id: nanoid(),
          type: "sell_home",
          name: "Sell Home A",
          startDate: "2027-06-01",
          realEstateAccountId: homeA.id,
          netProceeds: 140_000,
          proceedsAccountId: checking.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);
    const y2028 = result.years.find((y) => y.year === 2028)!;

    // Home A (sold) is fully retired.
    expect(y2028.accountBalances[homeA.id]).toBeCloseTo(0, 2);
    expect(y2028.accountBalances[mortgageA.id]).toBeCloseTo(0, 2);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgageA.id)).toBe(false);

    // Home B (untouched) keeps its balance, mortgage payments, and property tax.
    expect(y2028.accountBalances[homeB.id]).toBeCloseTo(500_000, 0);
    expect(y2028.accountBalances[mortgageB.id]).toBeGreaterThan(0);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgageB.id)).toBe(true);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === `${homeB.id}:ownership_costs`)).toBe(true);
  });
});

describe("forecastScenario -- sell_home", () => {
  it("credits net proceeds and fully retires the home's asset and mortgage (not just frozen)", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate",
      name: "Home",
      startingBalance: 400_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.01,
    });
    const mortgage = makeAccount({
      class: "mortgage",
      name: "Mortgage",
      startingBalance: 200_000,
      growthRatePct: 0,
      loanTerms: {
        originalPrincipal: 200_000,
        originationDate: "2026-01-01",
        annualInterestRatePct: 0.06,
        termMonths: 360,
        linkedAssetId: home.id,
      },
    });
    const scenario = makeScenario({
      accounts: [checking, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
      events: [
        {
          id: nanoid(),
          type: "sell_home",
          name: "Sell the house",
          startDate: "2027-06-01",
          realEstateAccountId: home.id,
          netProceeds: 175_000,
          proceedsAccountId: checking.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);

    // Proceeds landed straight in checking (a hub-touching transfer, same
    // bucket a buy_home down payment uses).
    const saleYear = result.years.find((y) => y.year === 2027)!;
    expect(saleYear.cashFlow.otherAccountActivity).toBeCloseTo(175_000, 0);

    // Both accounts fully zeroed (not just frozen) from the sale onward.
    const y2028 = result.years.find((y) => y.year === 2028)!;
    expect(y2028.accountBalances[home.id]).toBeCloseTo(0, 2);
    expect(y2028.accountBalances[mortgage.id]).toBeCloseTo(0, 2);

    // No more mortgage payments or property tax after the sale.
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgage.id)).toBe(false);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === `${home.id}:property_tax`)).toBe(false);
  });

  it("selling one of two homes leaves the other's mortgage and costs untouched", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const homeA = makeAccount({ class: "real_estate", name: "Home A", startingBalance: 300_000, growthRatePct: 0, propertyGrowthRatePct: 0, propertyTaxRatePct: 0.01 });
    const mortgageA = makeAccount({
      class: "mortgage",
      name: "Mortgage A",
      startingBalance: 150_000,
      growthRatePct: 0,
      loanTerms: { originalPrincipal: 150_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: homeA.id },
    });
    const homeB = makeAccount({ class: "real_estate", name: "Home B", startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0, propertyTaxRatePct: 0.01 });
    const mortgageB = makeAccount({
      class: "mortgage",
      name: "Mortgage B",
      startingBalance: 300_000,
      growthRatePct: 0,
      loanTerms: { originalPrincipal: 300_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: homeB.id },
    });
    const scenario = makeScenario({
      accounts: [
        checking,
        { ...homeA, linkedLiabilityId: mortgageA.id },
        mortgageA,
        { ...homeB, linkedLiabilityId: mortgageB.id },
        mortgageB,
      ],
      events: [
        {
          id: nanoid(),
          type: "sell_home",
          name: "Sell Home A",
          startDate: "2027-06-01",
          realEstateAccountId: homeA.id,
          netProceeds: 140_000,
          proceedsAccountId: checking.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);
    const y2028 = result.years.find((y) => y.year === 2028)!;

    // Home A (sold) is fully retired.
    expect(y2028.accountBalances[homeA.id]).toBeCloseTo(0, 2);
    expect(y2028.accountBalances[mortgageA.id]).toBeCloseTo(0, 2);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgageA.id)).toBe(false);

    // Home B (untouched) keeps its balance, mortgage payments, and property tax.
    expect(y2028.accountBalances[homeB.id]).toBeCloseTo(500_000, 0);
    expect(y2028.accountBalances[mortgageB.id]).toBeGreaterThan(0);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === mortgageB.id)).toBe(true);
    expect(y2028.cashFlow.expenseByItem.some((i) => i.id === `${homeB.id}:property_tax`)).toBe(true);
  });
});

describe("forecastScenario -- exposes the full resolved account list", () => {
  it("includes the buy_home event's real estate + mortgage accounts, same count as Scenario.accounts", () => {
    // The home a buy_home event purchases is now a real, permanent Account
    // (see src/lib/buyHome.ts) -- resolveEvents no longer synthesizes extra
    // accounts on top of Scenario.accounts, it just passes them through.
    const result = forecastScenario(mockScenario);
    expect(result.accounts.length).toBe(mockScenario.accounts.length);
    expect(result.accounts.some((a) => a.class === "real_estate")).toBe(true);
    expect(result.accounts.some((a) => a.class === "mortgage")).toBe(true);
    // Every accountId referenced anywhere in the output must resolve to a name via this list.
    const ids = new Set(result.accounts.map((a) => a.id));
    for (const entry of result.ledger) {
      expect(ids.has(entry.accountId), entry.note).toBe(true);
      if (entry.toAccountId) expect(ids.has(entry.toAccountId), entry.note).toBe(true);
    }
  });
});

describe("forecastScenario -- rollforward invariant", () => {
  it("every account-year rollforward balances: start + growth + deposits - withdrawals = end", () => {
    const result = forecastScenario(mockScenario);
    for (const year of result.years) {
      for (const r of year.rollforwards) {
        const computed = r.startingBalance + r.growth + r.deposits - r.withdrawals;
        expect(computed, `${r.accountId} in ${r.year}`).toBeCloseTo(r.endingBalance, 2);
      }
    }
  });
});

describe("forecastScenario -- account contributions", () => {
  it("payroll-deducted contribution grows the account with no cash outflow", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const four01k = makeAccount({
      class: "tax_deferred",
      name: "401k",
      taxTreatment: "tax_deferred",
      ownerId: nanoid(),
      startingBalance: 0,
      growthRatePct: 0,
      contribution: { amount: 1000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [checking, four01k],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const year = forecastScenario(scenario).years[0];

    // 12 monthly $1000 payroll-deducted contributions grow the 401k...
    expect(year.accountBalances[four01k.id]).toBeCloseTo(12_000, 0);
    // ...with zero cash-flow cost: net cash flow is just income, no contribution drag.
    expect(year.cashFlow.afterTaxContributionTotal).toBe(0);
    expect(year.cashFlow.netCashFlow).toBeCloseTo(60_000, 0);
    const line = year.cashFlow.contributionsByItem.find((c) => c.id === `${four01k.id}:contribution`);
    expect(line?.fromPaycheck).toBe(true);
    expect(line?.amount).toBeCloseTo(12_000, 0);
  });

  it("take-home-funded contribution grows the account and draws from the spending account", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 0,
      growthRatePct: 0,
      contribution: { amount: 1000, frequency: "monthly", growthRatePct: 0, payrollDeducted: false },
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const year = forecastScenario(scenario).years[0];

    expect(year.accountBalances[brokerage.id]).toBeCloseTo(12_000, 0); // contributions landed
    expect(year.accountBalances[checking.id]).toBeCloseTo(48_000, 0); // 60k income - 12k contributed
    expect(year.cashFlow.afterTaxContributionTotal).toBeCloseTo(12_000, 0);
    expect(year.cashFlow.netCashFlow).toBeCloseTo(48_000, 0); // income - take-home contributions
    const line = year.cashFlow.contributionsByItem.find((c) => c.id === `${brokerage.id}:contribution`);
    expect(line?.fromPaycheck).toBe(false);
  });

  it("Roth 401(k): after-tax (tax_free) but payroll-deducted, so NOT a cash outflow", () => {
    // Regression: cash-flow treatment must follow payrollDeducted, not tax treatment.
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const roth401k = makeAccount({
      class: "tax_free",
      name: "Roth 401k",
      taxTreatment: "tax_free",
      ownerId: nanoid(),
      startingBalance: 0,
      growthRatePct: 0,
      contribution: { amount: 1000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [checking, roth401k],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const year = forecastScenario(scenario).years[0];

    expect(year.accountBalances[roth401k.id]).toBeCloseTo(12_000, 0); // grows
    expect(year.accountBalances[checking.id]).toBeCloseTo(60_000, 0); // untouched by the contribution
    expect(year.cashFlow.afterTaxContributionTotal).toBe(0); // no cash-flow drag despite being after-tax
    expect(year.cashFlow.netCashFlow).toBeCloseTo(60_000, 0);
    const line = year.cashFlow.contributionsByItem.find((c) => c.id === `${roth401k.id}:contribution`);
    expect(line?.fromPaycheck).toBe(true);
  });
});

describe("forecastScenario -- variable contribution & growth-rate schedules", () => {
  it("a growth-rate schedule changes the applied rate on the scheduled date", () => {
    const account = makeAccount({
      class: "taxable_investment",
      startingBalance: 100_000,
      growthRatePct: 0.08,
      growthRateSchedule: [{ startDate: "2028-01-01", ratePct: 0.02 }],
    });
    const scenario = makeScenario({
      accounts: [account],
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
    });
    const result = forecastScenario(scenario);

    const oldMonthlyRate = Math.pow(1.08, 1 / 12) - 1;
    const newMonthlyRate = Math.pow(1.02, 1 / 12) - 1;
    // 23 months at the base rate (account's own creation month is skipped),
    // then 24 months at the scheduled rate once it starts.
    const expected = 100_000 * Math.pow(1 + oldMonthlyRate, 23) * Math.pow(1 + newMonthlyRate, 24);
    expect(result.years[3].accountBalances[account.id]).toBeCloseTo(expected, 0);
  });

  it("applies successive growth-rate schedule entries on the same account in order", () => {
    const account = makeAccount({
      class: "taxable_investment",
      startingBalance: 100_000,
      growthRatePct: 0.08,
      growthRateSchedule: [
        { startDate: "2027-01-01", ratePct: 0.04 },
        { startDate: "2028-06-01", ratePct: 0.01 },
      ],
    });
    const scenario = makeScenario({
      accounts: [account],
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
    });
    const result = forecastScenario(scenario);

    const m08 = Math.pow(1.08, 1 / 12) - 1;
    const m04 = Math.pow(1.04, 1 / 12) - 1;
    const m01 = Math.pow(1.01, 1 / 12) - 1;
    // 11 months (2026-02..12) at the base 8%, then the 4% entry takes over
    // 2027-01-01 through 2028-05 (12 + 5 = 17 months), then the 1% entry
    // takes over from 2028-06-01 through end of 2029 (7 + 12 = 19 months).
    const expected = 100_000 * Math.pow(1 + m08, 11) * Math.pow(1 + m04, 17) * Math.pow(1 + m01, 19);
    expect(result.years[3].accountBalances[account.id]).toBeCloseTo(expected, 0);
  });

  it("multi-segment contributions post the right amount in each segment's window", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const four01k = makeAccount({
      class: "tax_deferred",
      name: "401k",
      taxTreatment: "tax_deferred",
      ownerId: nanoid(),
      startingBalance: 0,
      growthRatePct: 0,
      contributionSchedule: [
        { startDate: "2026-01-01", amount: 1_500, frequency: "monthly", growthRatePct: 0, payrollDeducted: true, endDate: "2027-12-31" },
        { startDate: "2028-01-01", amount: 2_000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
      ],
    });
    const scenario = makeScenario({
      accounts: [checking, four01k],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);
    const byYear = (y: number) => result.years.find((row) => row.year === y)!;

    expect(byYear(2026).accountBalances[four01k.id]).toBeCloseTo(18_000, 0); // $1,500 x 12
    expect(byYear(2027).accountBalances[four01k.id]).toBeCloseTo(36_000, 0); // + another $1,500 x 12
    expect(byYear(2028).accountBalances[four01k.id]).toBeCloseTo(60_000, 0); // + $2,000 x 12 from the new segment
  });

  it("a take-home-funded segment still draws from the spending account, same as the single-value contribution path", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 0,
      growthRatePct: 0,
      contributionSchedule: [
        { startDate: "2026-01-01", amount: 1_000, frequency: "monthly", growthRatePct: 0, payrollDeducted: false },
      ],
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const year = forecastScenario(scenario).years[0];

    expect(year.accountBalances[brokerage.id]).toBeCloseTo(12_000, 0);
    expect(year.accountBalances[checking.id]).toBeCloseTo(48_000, 0); // 60k income - 12k contributed
    expect(year.cashFlow.afterTaxContributionTotal).toBeCloseTo(12_000, 0);
  });

  it("a single-value account with no schedule fields behaves exactly as before this feature", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const four01k = makeAccount({
      class: "tax_deferred",
      name: "401k",
      taxTreatment: "tax_deferred",
      ownerId: nanoid(),
      startingBalance: 0,
      growthRatePct: 0,
      contribution: { amount: 1000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [checking, four01k],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const year = forecastScenario(scenario).years[0];

    expect(year.accountBalances[four01k.id]).toBeCloseTo(12_000, 0);
    expect(year.cashFlow.afterTaxContributionTotal).toBe(0);
  });
});

describe("forecastScenario -- cash flow statement reconciles exactly", () => {
  it("every itemized bucket sums to the measured change in cash on hand, every year", () => {
    // The mock scenario includes an edge case on purpose: "Inheritance" income
    // deposits straight into the brokerage (a non-hub account), never touching
    // checking. If the itemized rows didn't correctly exclude that from
    // "reached cash," this test would catch the ~$50k gap the year it lands.
    const result = forecastScenario(mockScenario);
    expect(result.years.length).toBeGreaterThan(50);
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

  it("withdrawal gross always equals net + tax, per account per year", () => {
    const result = forecastScenario(mockScenario);
    for (const year of result.years) {
      for (const w of year.cashFlow.withdrawalsByAccount) {
        expect(w.gross, `${w.label} in ${year.year}`).toBeCloseTo(w.net + w.tax, 6);
      }
    }
  });

  it("catches income landed directly in a non-hub account (the Inheritance edge case)", () => {
    // Confirms the edge case actually exercises directIncomeToOtherAccounts /
    // otherAccountActivity, rather than the reconciliation test above passing
    // vacuously because the scenario never hits that path.
    const result = forecastScenario(mockScenario);
    const inheritanceYear = result.years.find((y) => y.year === 2035)!;
    expect(inheritanceYear.cashFlow.otherAccountActivity).toBeLessThan(-1000);
  });

  it("reconciles a scenario with a hub-to-hub custom_transfer and a down payment sourced from the hub", () => {
    // Exercises hubTransferNet directly: both a custom_transfer touching the
    // hub and a buy_home down payment sourced from the hub.
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 500_000 });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 50_000 });
    const home = makeAccount({
      class: "real_estate",
      name: "Buy a home",
      startingBalance: 200_000,
      growthRatePct: 0,
      propertyGrowthRatePct: 0,
      startDate: "2026-06-01",
    });
    const scenario = makeScenario({
      accounts: [checking, savings, home],
      events: [
        {
          id: nanoid(),
          type: "custom_transfer",
          name: "Move to savings",
          startDate: "2026-03-01",
          amount: 10_000,
          fromAccountId: checking.id,
          toAccountId: savings.id,
          frequency: "one_time",
        },
        {
          id: nanoid(),
          type: "buy_home",
          name: "Buy a home",
          startDate: "2026-06-01",
          purchasePrice: 200_000,
          downPaymentAmount: 40_000,
          downPaymentFromAccountId: checking.id,
          realEstateAccountId: home.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];
    const cf = year.cashFlow;
    const explained =
      cf.operatingCashFlow + cf.withdrawalsToCashNet - cf.afterTaxContributionTotal - cf.surplusRouted + cf.cashInterest + cf.otherAccountActivity;
    expect(explained).toBeCloseTo(cf.netCashFlow, 2);
    // Both outflows left checking directly: -$10k transfer, -$40k down payment.
    expect(cf.otherAccountActivity).toBeCloseTo(-50_000, 0);
    expect(cf.netCashFlow).toBeCloseTo(-50_000, 0);
  });
});

describe("forecastScenario -- per-item cash-flow breakdown", () => {
  it("income and expense line items reconcile to the year totals (incl. mortgage payments)", () => {
    const result = forecastScenario(mockScenario);
    for (const year of result.years) {
      const incomeSum = year.cashFlow.incomeByItem.reduce((s, i) => s + i.amount, 0);
      const expenseSum = year.cashFlow.expenseByItem.reduce((s, i) => s + i.amount, 0);
      expect(incomeSum, `income items in ${year.year}`).toBeCloseTo(year.cashFlow.totalIncome, 2);
      expect(expenseSum, `expense items in ${year.year}`).toBeCloseTo(year.cashFlow.totalExpenses, 2);
    }
  });

  it("breaks each salary out as its own income line in the first year", () => {
    const result = forecastScenario(mockScenario);
    const labels = result.years[0].cashFlow.incomeByItem.map((i) => i.label);
    expect(labels).toContain("Alex Salary");
    expect(labels).toContain("Jordan Salary");
  });
});

describe("forecastScenario -- mock fixture end-to-end", () => {
  it("produces a plausible, internally consistent projection", () => {
    const result = forecastScenario(mockScenario);
    expect(result.years.length).toBeGreaterThan(50);
    expect(result.years[0].netWorthNominal).toBeGreaterThan(0);
    // Net worth should generally trend upward through the working years.
    expect(result.years[10].netWorthNominal).toBeGreaterThan(result.years[0].netWorthNominal);
    expect(result.kpis.retirementAge).toBe(65);
    expect(result.kpis.netWorthAtRetirement).not.toBeNull();
  });
});

describe("forecastScenario -- contributions stop at retirement", () => {
  it("stops an owned account's contributions the day the owner retires", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const k401 = makeAccount({
      class: "tax_deferred",
      name: "401(k)",
      ownerId: personId,
      contribution: { amount: 1000, frequency: "monthly", growthRatePct: 0, payrollDeducted: true },
    });
    const scenario = makeScenario({
      accounts: [checking, k401],
      people: [{ id: personId, name: "Worker", birthDate: "1965-01-01", retirementAge: 63, planningEndAge: 95 }],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2028-01-01", personId }],
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
    });
    const result = forecastScenario(scenario);
    const balAt = (year: number) => result.years.find((y) => y.year === year)!.accountBalances[k401.id];

    // 24 monthly contributions across 2026-2027, then nothing once retired.
    expect(balAt(2027)).toBeCloseTo(24_000, 0);
    expect(balAt(2028)).toBeCloseTo(24_000, 0);
    expect(balAt(2029)).toBeCloseTo(24_000, 0);
  });

  it("honors a manual contribution end date", () => {
    const roth = makeAccount({
      class: "tax_free",
      name: "Roth IRA",
      contribution: {
        amount: 500,
        frequency: "monthly",
        growthRatePct: 0,
        payrollDeducted: true,
        endDate: "2026-06-30",
      },
    });
    const scenario = makeScenario({ accounts: [roth], horizonEndDate: "2026-12-31" });
    const result = forecastScenario(scenario);

    // 6 contributions (Jan-Jun), then stopped.
    expect(result.years[0].accountBalances[roth.id]).toBeCloseTo(3_000, 0);
  });
});

describe("forecastScenario -- social security COLA", () => {
  // Social Security is not a separate event type -- it's a plain Income
  // entry with category "social_security", which is what triggers the
  // once-per-year (not continuous) COLA compounding in the engine.
  const setup = (growthRatePct: number) => {
    const pid = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000 });
    return makeScenario({
      accounts: [checking],
      people: [{ id: pid, name: "P", birthDate: "1960-01-01", retirementAge: 65, planningEndAge: 95 }],
      incomeSources: [
        makeIncome({
          name: "SS",
          ownerId: pid,
          amount: 2000,
          frequency: "monthly",
          startDate: "2026-01-01",
          growthRatePct,
          depositAccountId: checking.id,
          category: "social_security",
        }),
      ],
      inflationRatePct: 0.03,
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
    });
  };

  it("steps the COLA up once per year at a rate the user enters", () => {
    const r = forecastScenario(setup(0.03)); // COLA matching the plan's inflation assumption
    const y26 = r.years.find((y) => y.year === 2026)!.cashFlow.totalIncome;
    const y29 = r.years.find((y) => y.year === 2029)!.cashFlow.totalIncome;
    expect(y29).toBeCloseTo(y26 * 1.03 ** 3, -1); // grew at ~3% (once-per-year COLA compounding)
  });

  it("honors an explicit COLA that differs from inflation", () => {
    const r = forecastScenario(setup(0)); // 0% COLA -> flat in nominal terms
    const y26 = r.years.find((y) => y.year === 2026)!.cashFlow.totalIncome;
    const y29 = r.years.find((y) => y.year === 2029)!.cashFlow.totalIncome;
    expect(y29).toBeCloseTo(y26, 0);
    expect(y26).toBeCloseTo(24_000, 0); // 2000/mo, flat
  });

  it("treats the entered amount as today's dollars (real value stays flat, nominal inflates)", () => {
    const pid = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000 });
    const scenario = makeScenario({
      accounts: [checking],
      people: [{ id: pid, name: "P", birthDate: "1960-01-01", retirementAge: 65, planningEndAge: 95 }],
      incomeSources: [
        makeIncome({
          name: "SS",
          ownerId: pid,
          amount: 3000,
          frequency: "monthly",
          startDate: "2040-01-01", // starts well after the plan start
          growthRatePct: 0.03,
          depositAccountId: checking.id,
          category: "social_security",
        }),
      ],
      inflationRatePct: 0.03,
      startDate: "2026-01-01",
      horizonEndDate: "2041-12-31",
    });
    const r = forecastScenario(scenario);
    const y2040 = r.years.find((y) => y.year === 2040)!;
    const y2041 = r.years.find((y) => y.year === 2041)!;
    // The $3,000/mo is entered in today's dollars, so its REAL (deflated) value
    // in the first year is ~12 * $3,000 = $36,000 -- not the nominal amount.
    const real2040 = y2040.cashFlow.totalIncome / y2040.inflationDeflator;
    const real2041 = y2041.cashFlow.totalIncome / y2041.inflationDeflator;
    expect(real2040).toBeCloseTo(36_000, -3); // ~$36k in today's dollars
    expect(real2041).toBeCloseTo(36_000, -3); // stays flat in real terms
    // Nominally the benefit has been inflated to future dollars by ~14 years of
    // COLA, so it lands well above the entered $36,000.
    expect(y2040.cashFlow.totalIncome).toBeGreaterThan(50_000);
  });
});

describe("forecastScenario -- today's dollars for future-dated baseline income & expenses", () => {
  // Income/expense events can no longer create a new source (see EventDrawer) --
  // a future-dated income source or expense is just a baseline entry with a
  // startDate after the plan start. These confirm that path still gets the
  // same today's-dollars treatment as everything else.
  it("treats a baseline income source starting years out as today's dollars", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000 });
    const newJob = makeIncome({
      name: "New job",
      amount: 5_000,
      frequency: "monthly",
      startDate: "2040-01-01", // starts well after the plan start
      growthRatePct: 0,
      depositAccountId: checking.id,
    });
    const scenario = makeScenario({
      accounts: [checking],
      incomeSources: [newJob],
      inflationRatePct: 0.03,
      startDate: "2026-01-01",
      horizonEndDate: "2041-12-31",
    });
    const r = forecastScenario(scenario);
    const y2040 = r.years.find((y) => y.year === 2040)!;
    const real2040 = y2040.cashFlow.totalIncome / y2040.inflationDeflator;
    expect(real2040).toBeCloseTo(60_000, -3); // $5,000/mo in today's dollars
    expect(y2040.cashFlow.totalIncome).toBeGreaterThan(80_000); // nominal is inflated well above that
  });

  it("treats a baseline expense starting years out as today's dollars", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000 });
    const newLease = makeExpense({
      name: "New lease",
      amount: 1_000,
      frequency: "monthly",
      startDate: "2040-01-01",
      growthRatePct: 0,
      paymentAccountId: checking.id,
    });
    const scenario = makeScenario({
      accounts: [checking],
      expenses: [newLease],
      inflationRatePct: 0.03,
      startDate: "2026-01-01",
      horizonEndDate: "2041-12-31",
    });
    const r = forecastScenario(scenario);
    const y2040 = r.years.find((y) => y.year === 2040)!;
    const real2040 = y2040.cashFlow.totalExpenses / y2040.inflationDeflator;
    expect(real2040).toBeCloseTo(12_000, -3); // $1,000/mo in today's dollars
    expect(y2040.cashFlow.totalExpenses).toBeGreaterThan(16_000); // nominal is inflated well above that
  });
});

describe("forecastScenario -- starting balance", () => {
  it("shows the opening balance as the first-year starting balance, not a deposit", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 15_000, growthRatePct: 0 });
    const r = forecastScenario(makeScenario({ accounts: [checking], horizonEndDate: "2026-12-31" }));
    const rf = r.years[0].rollforwards.find((x) => x.accountId === checking.id)!;
    expect(rf.startingBalance).toBeCloseTo(15_000, 0);
    expect(rf.deposits).toBeCloseTo(0, 0);
    expect(rf.endingBalance).toBeCloseTo(15_000, 0);
  });
});

describe("forecastScenario -- recurring expense every N years", () => {
  it("charges a repeat expense every N years and skips the years between", () => {
    const checking = makeAccount({
      class: "cash",
      name: "Checking",
      isSpendingAccount: true,
      startingBalance: 100_000,
    });
    const scenario = makeScenario({
      accounts: [checking],
      expenses: [
        makeExpense({
          paymentAccountId: checking.id,
          name: "New car",
          amount: 20_000,
          frequency: "one_time",
          intervalYears: 5,
          startDate: "2026-01-01",
          growthRatePct: 0,
        }),
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2036-12-31",
    });
    const result = forecastScenario(scenario);
    const expenseIn = (year: number) => result.years.find((y) => y.year === year)!.cashFlow.totalExpenses;

    // Fires 2026, 2031, 2036; nothing in between.
    expect(expenseIn(2026)).toBeCloseTo(20_000, 0);
    expect(expenseIn(2028)).toBeCloseTo(0, 0);
    expect(expenseIn(2031)).toBeCloseTo(20_000, 0);
    expect(expenseIn(2036)).toBeCloseTo(20_000, 0);
    // $100k - three $20k purchases.
    expect(result.years.find((y) => y.year === 2036)!.accountBalances[checking.id]).toBeCloseTo(40_000, 0);
  });
});

describe("forecastScenario -- withdrawal taxes", () => {
  it("leaves withdrawals untaxed on a raw forecastScenario() call with no rates supplied", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      withdrawalPriority: 1,
      startingBalance: 100_000,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 1000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // No tax rates -> legacy behavior: pull exactly the shortfall, no tax.
    expect(year.accountBalances[ira.id]).toBeCloseTo(88_000, 0);
    expect(year.cashFlow.withdrawalTaxes).toBeCloseTo(0, 0);
  });

  it("taxes a $90k sole-income 401k withdrawal using real progressive brackets, not a flat rate", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      withdrawalPriority: 1,
      startingBalance: 500_000,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 7_500 })], // $90k/yr, no other income
      horizonEndDate: "2026-12-31",
    });
    const result = projectScenario(scenario);
    const year = result.years[0];
    const iraWithdrawal = year.cashFlow.withdrawalsByAccount.find((w) => w.id === ira.id)!;

    // $90k reaches spending net of tax (the deficit cascade sizes withdrawals
    // to net exactly the shortfall, regardless of the rate estimate).
    expect(year.cashFlow.withdrawalsToCashNet).toBeCloseTo(90_000, -2);
    expect(iraWithdrawal.net).toBeCloseTo(90_000, -2);
    // $90k taxable income minus the $32,200 MFJ standard deduction lands in
    // the 12% bracket -- real tax is a few thousand dollars, nowhere near
    // the old flat-22%-of-gross approximation (~$20k+).
    expect(year.cashFlow.federalTaxTotal).toBeGreaterThan(4_000);
    expect(year.cashFlow.federalTaxTotal).toBeLessThan(9_000);
    expect(year.cashFlow.federalTaxTotal / iraWithdrawal.gross).toBeLessThan(0.1);
  });

  it("realizes zero capital-gains tax on a taxable-account transfer that's pure basis (no gain yet)", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 100_000,
      growthRatePct: 0,
    });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [checking, brokerage, savings],
      events: [
        {
          id: nanoid(),
          type: "custom_transfer",
          name: "Move to savings",
          startDate: "2026-06-01",
          amount: 50_000,
          fromAccountId: brokerage.id,
          toAccountId: savings.id,
          frequency: "one_time",
        },
      ],
      horizonEndDate: "2026-12-31",
    });
    const result = projectScenario(scenario);
    const year = result.years[0];

    // No growth, no contributions -> the whole balance is basis, so the
    // draw carries no gain and realizes no tax (old flat-15%-of-everything
    // proxy would have charged $7,500 regardless).
    expect(year.accountBalances[savings.id]).toBeCloseTo(50_000, 0);
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(50_000, 0);
    expect(year.cashFlow.capitalGainsRealized).toBeCloseTo(0, 2);
    expect(year.cashFlow.federalTaxTotal).toBeCloseTo(0, 0);
  });

  it("taxes only the realized-gain portion of a taxable-account draw once the account has grown", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 100_000,
      growthRatePct: 0.2,
    });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 0 });
    const scenario = makeScenario({
      accounts: [checking, brokerage, savings],
      events: [
        {
          id: nanoid(),
          type: "custom_transfer",
          name: "Move to savings",
          startDate: "2027-06-01", // after a full year of 20% growth on top of the $100k basis
          amount: 60_000,
          fromAccountId: brokerage.id,
          toAccountId: savings.id,
          frequency: "one_time",
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = projectScenario(scenario);
    const year2 = result.years[1];

    // The account has clearly grown past its $100k basis by mid-2027, so
    // some -- but not all -- of the $60k draw is a realized gain.
    expect(year2.cashFlow.capitalGainsRealized).toBeGreaterThan(0);
    expect(year2.cashFlow.capitalGainsRealized).toBeLessThan(60_000);
    // The gain here (well under $98,900 MFJ) sits entirely in the 0% LTCG
    // bracket, so real tax is $0 -- the old flat-15%-of-the-whole-draw proxy
    // would have charged $9,000 regardless of there being no meaningful gain.
    expect(year2.cashFlow.federalTaxTotal).toBeLessThan(500);
  });

  it("taxes an RMD using real progressive brackets -- $0 when it's below the standard deduction", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      ownerId: personId,
      taxTreatment: "tax_deferred",
      subjectToRMD: true,
      startingBalance: 500_000,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      people: [{ id: personId, name: "Retiree", birthDate: "1953-01-01", retirementAge: 65, planningEndAge: 95 }],
      startDate: "2025-01-01",
      horizonEndDate: "2026-12-31",
    });
    const result = projectScenario(scenario);
    // Turns 73 in 2026 -> RMD fires that year off the 2025 year-end balance.
    const year = result.years[1];

    expect(year.cashFlow.rmdTotal).toBeGreaterThan(0);
    // $500k / ~26.5 divisor =~ $18.9k RMD, comfortably under the $32,200 MFJ
    // standard deduction with no other income -- real tax is $0. The old
    // flat-rate model would have charged real money regardless.
    expect(year.cashFlow.federalTaxTotal).toBeCloseTo(0, 0);
  });

  it("computes Social Security's partial taxability alongside a tax-deferred withdrawal", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      ownerId: personId,
      taxTreatment: "tax_deferred",
      withdrawalPriority: 1,
      startingBalance: 500_000,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      incomeSources: [
        makeIncome({ depositAccountId: checking.id, amount: 3_000, frequency: "monthly", category: "social_security" }),
      ], // $36k/yr gross
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 9_000 })], // $108k/yr -> ~$72k/yr from the IRA
      people: [{ id: personId, name: "Retiree", birthDate: "1953-01-01", retirementAge: 65, planningEndAge: 95 }],
      horizonEndDate: "2026-12-31",
    });
    const result = projectScenario(scenario);
    const year = result.years[0];

    expect(year.cashFlow.grossSocialSecurity).toBeCloseTo(36_000, 0);
    // Combined with a sizeable IRA draw, provisional income clears the $44k
    // MFJ threshold, so a meaningful (but not necessarily the full 85% cap)
    // share of the benefit ends up taxable.
    expect(year.cashFlow.taxableSocialSecurityAmount).toBeGreaterThan(0);
    expect(year.cashFlow.taxableSocialSecurityAmount).toBeLessThanOrEqual(36_000 * 0.85 + 0.5);
    expect(year.cashFlow.federalTaxTotal).toBeGreaterThan(0);
  });

  it("splits federal tax into components that sum to the total, with pension and SS each getting a sensible share", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      ownerId: personId,
      taxTreatment: "tax_deferred",
      subjectToRMD: true,
      startingBalance: 500_000,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      incomeSources: [
        makeIncome({ depositAccountId: checking.id, amount: 3_000, frequency: "monthly", category: "social_security" }), // $36k/yr gross
        makeIncome({ depositAccountId: checking.id, amount: 2_000, frequency: "monthly", category: "pension" }), // $24k/yr gross
      ],
      people: [{ id: personId, name: "Retiree", birthDate: "1953-01-01", retirementAge: 65, planningEndAge: 95 }],
      startDate: "2025-01-01",
      horizonEndDate: "2026-12-31",
    });
    const result = projectScenario(scenario);
    // Turns 73 in 2026 -> RMD fires that year off the 2025 year-end IRA balance.
    const year = result.years[1];

    expect(year.cashFlow.rmdTotal).toBeGreaterThan(0);

    const componentSum = year.cashFlow.federalTaxByComponent.reduce((s, c) => s + c.amount, 0);
    expect(componentSum).toBeCloseTo(year.cashFlow.federalTaxTotal, 2);

    const byKey = new Map(year.cashFlow.federalTaxByComponent.map((c) => [c.key, c.amount]));
    expect(byKey.get("pension")).toBeGreaterThan(0);
    expect(byKey.get("taxable_social_security")).toBeGreaterThan(0);
    expect(byKey.get("tax_deferred")).toBeGreaterThan(0);
  });
});

describe("forecastScenario -- isExcluded (real exclusion, not cosmetic)", () => {
  it("freezes an excluded account's balance and drops it from net worth, KPIs, and cash flow", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 10_000, growthRatePct: 0 });
    const utma = makeAccount({ class: "cash", name: "Kid's UTMA", startingBalance: 5_000, growthRatePct: 0.1, isExcluded: true });
    const scenario = makeScenario({
      accounts: [checking, utma],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 1000 })],
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const year2 = result.years[1];

    // Frozen at its starting balance despite a 10% growth rate -- no growth applied.
    expect(year2.accountBalances[utma.id]).toBeCloseTo(5_000, 0);
    // Net worth only reflects the non-excluded account.
    expect(year2.netWorthNominal).toBeCloseTo(year2.accountBalances[checking.id], 0);
    expect(year2.totalAssetsNominal).toBeCloseTo(year2.accountBalances[checking.id], 0);
  });

  it("drops postings targeting an excluded account, without also silently draining the paired account", () => {
    // A take-home-funded contribution into an excluded account must not still
    // pull money out of checking with nowhere for it to land.
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const excludedBrokerage = makeAccount({
      class: "taxable_investment",
      name: "Excluded Brokerage",
      isExcluded: true,
      contribution: { amount: 500, frequency: "monthly", growthRatePct: 0, payrollDeducted: false },
    });
    const scenario = makeScenario({
      accounts: [checking, excludedBrokerage],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5000 })],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    expect(year.accountBalances[excludedBrokerage.id]).toBeCloseTo(0, 0); // no contribution landed
    expect(year.accountBalances[checking.id]).toBeCloseTo(60_000, 0); // untouched by the (skipped) contribution draw
  });

  it("an excluded event doesn't count toward the retirement KPI", () => {
    const personId = nanoid();
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true });
    const scenario = makeScenario({
      accounts: [checking],
      people: [{ id: personId, name: "Worker", birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 }],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-07-01", personId, isExcluded: true }],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    expect(result.kpis.retirementAge).toBeNull();
  });
});

describe("forecastScenario -- moneyFlow (Extra Savings, expressed directly)", () => {
  it("only sweeps Extra Savings -- income deposited straight into an ordinary account stays put, unswept", () => {
    const extraSavings = makeAccount({ class: "cash", name: "Extra Savings", startingBalance: 0, growthRatePct: 0, isSpendingAccount: true });
    const checking = makeAccount({ class: "cash", name: "Checking", startingBalance: 0, growthRatePct: 0 });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 0, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [extraSavings, checking, savings],
      incomeSources: [
        makeIncome({ depositAccountId: extraSavings.id, amount: 3000 }),
        // Deposited directly into an ordinary (non-Extra-Savings) account --
        // there's only ever one hub now, so this money is never swept.
        makeIncome({ depositAccountId: checking.id, amount: 2000 }),
      ],
      horizonEndDate: "2026-12-31",
      moneyFlow: {
        splitOrder: [{ id: "s1", accountId: savings.id, kind: "percent_of_remainder", amount: null, pct: 1, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: null, endDate: null }],
        drainOrder: [],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // Extra Savings sweeps everything (no floor) into the split target.
    expect(year.accountBalances[extraSavings.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[savings.id]).toBeCloseTo(3000 * 12, 0);
    // Checking's direct deposit was never routed through Extra Savings, so
    // it just accumulates in place.
    expect(year.accountBalances[checking.id]).toBeCloseTo(2000 * 12, 0);
  });
});

describe("forecastScenario -- drain order date windows and splitting", () => {
  it("only drains a stop within its date window, then the next stop picks up", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 200_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 200_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 5_000 })], // $60k/yr shortfall
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: "2027-12-31", splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: "2028-01-01", endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const byYear = (y: number) => result.years.find((row) => row.year === y)!;

    // Brokerage funds 2026-2027 (its window); IRA untouched during that time.
    expect(byYear(2026).accountBalances[brokerage.id]).toBeCloseTo(140_000, 0);
    expect(byYear(2027).accountBalances[brokerage.id]).toBeCloseTo(80_000, 0);
    expect(byYear(2026).accountBalances[ira.id]).toBeCloseTo(200_000, 0);
    expect(byYear(2027).accountBalances[ira.id]).toBeCloseTo(200_000, 0);
    // IRA takes over starting 2028; brokerage is outside its window and untouched from here.
    expect(byYear(2028).accountBalances[brokerage.id]).toBeCloseTo(80_000, 0);
    expect(byYear(2028).accountBalances[ira.id]).toBeCloseTo(140_000, 0);
    expect(byYear(2029).accountBalances[brokerage.id]).toBeCloseTo(80_000, 0);
    expect(byYear(2029).accountBalances[ira.id]).toBeCloseTo(80_000, 0);
  });

  it("flags insufficient funds for a shortfall month with no active drain stop", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 200_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 1_000 })],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
      moneyFlow: {
        splitOrder: [],
        // IRA isn't active until 2027 -- 2026's shortfall has nowhere to go.
        drainOrder: [{ id: nanoid(), accountId: ira.id, startDate: "2027-01-01", endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null }],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    expect(result.warnings.some((w) => w.kind === "insufficient_funds" && w.year === 2026)).toBe(true);
    // 2027 onward the IRA is active and catches up: 2026's whole accumulated
    // shortfall ($12k) plus all of 2027's own shortfall ($12k) = $24k drawn.
    const y2027 = result.years.find((y) => y.year === 2027)!;
    expect(y2027.accountBalances[ira.id]).toBeCloseTo(200_000 - 24_000, 0);
    expect(y2027.accountBalances[checking.id]).toBeCloseTo(0, 0);
  });

  it("fixed_split divides a shortfall across active accounts by their configured percentages", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 10_000 })], // $120k/yr shortfall
      horizonEndDate: "2026-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: 0.4 , minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: null, endDate: null, splitPct: 0.6 , minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "fixed_split",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];
    // $120k shortfall split 40/60 -> $48k from brokerage, $72k from IRA.
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(500_000 - 48_000, 0);
    expect(year.accountBalances[ira.id]).toBeCloseTo(500_000 - 72_000, 0);
  });

  it("tops up from the other active source when one can't cover its full split target", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    // Only enough for 3 months at its $4,000/mo target (40% of the $10k/mo shortfall).
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 12_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 10_000 })], // $120k/yr shortfall
      horizonEndDate: "2026-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: 0.4 , minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: null, endDate: null, splitPct: 0.6 , minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "fixed_split",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];
    // Brokerage fully drains (only ever had $12k against a $48k annual target);
    // the IRA tops up the rest so the full $120k shortfall is still covered.
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[ira.id]).toBeCloseTo(500_000 - 108_000, 0);
    expect(year.cashFlow.operatingCashFlow + year.cashFlow.withdrawalsToCashNet).toBeCloseTo(0, 0);
  });

  it("renormalizes split percentages across only the currently-active stops", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    // A Roth with a 40% share that never becomes active during the simulated
    // horizon -- shouldn't leave 40% of the shortfall uncovered.
    const roth = makeAccount({
      class: "tax_free",
      name: "Roth",
      taxTreatment: "tax_free",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira, roth],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 8_333.33 })], // ~$100k/yr shortfall
      horizonEndDate: "2026-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: 0.3 , minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: null, endDate: null, splitPct: 0.3 , minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: roth.id, startDate: "2030-01-01", endDate: null, splitPct: 0.4 , minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "fixed_split",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];
    // Only brokerage and IRA are active (0.3 : 0.3 -> renormalized to 50/50),
    // so each covers about half of the ~$100k shortfall; Roth is untouched.
    const brokerageDrawn = 500_000 - year.accountBalances[brokerage.id];
    const iraDrawn = 500_000 - year.accountBalances[ira.id];
    expect(brokerageDrawn).toBeCloseTo(iraDrawn, -2);
    expect(brokerageDrawn + iraDrawn).toBeCloseTo(100_000, -1);
    expect(year.accountBalances[roth.id]).toBeCloseTo(500_000, 0);
  });

  it("supports the same account appearing more than once with different windows", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 5_000 })], // $60k/yr shortfall
      startDate: "2026-01-01",
      horizonEndDate: "2029-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          // Brokerage funds 2026, IRA takes 2027-2028, then Brokerage again from 2029.
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: "2026-12-31", splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: "2027-01-01", endDate: "2028-12-31", splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: brokerage.id, startDate: "2029-01-01", endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const byYear = (y: number) => result.years.find((row) => row.year === y)!;

    expect(byYear(2026).accountBalances[brokerage.id]).toBeCloseTo(440_000, 0);
    expect(byYear(2026).accountBalances[ira.id]).toBeCloseTo(500_000, 0);
    // IRA covers 2027-2028; brokerage's first window has ended and its
    // second hasn't started yet, so it's untouched through this stretch.
    expect(byYear(2027).accountBalances[ira.id]).toBeCloseTo(440_000, 0);
    expect(byYear(2027).accountBalances[brokerage.id]).toBeCloseTo(440_000, 0);
    expect(byYear(2028).accountBalances[ira.id]).toBeCloseTo(380_000, 0);
    expect(byYear(2028).accountBalances[brokerage.id]).toBeCloseTo(440_000, 0);
    // Brokerage's second window picks back up in 2029; IRA untouched from here.
    expect(byYear(2029).accountBalances[brokerage.id]).toBeCloseTo(380_000, 0);
    expect(byYear(2029).accountBalances[ira.id]).toBeCloseTo(380_000, 0);
  });

  it("replenishes Extra Savings to exactly its hardcoded $0 floor, not below", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 2_000 })],
      horizonEndDate: "2026-12-31",
      moneyFlow: {
        splitOrder: [],
        drainOrder: [{ id: nanoid(), accountId: ira.id, startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null }],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];
    expect(year.accountBalances[checking.id]).toBeCloseTo(0, 0);
    expect(year.accountBalances[ira.id]).toBeCloseTo(500_000 - 24_000, 0);
  });

  it("stops draining a source once it hits its inflation-grown floor, spilling the rest to the next source", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 110_000,
      growthRatePct: 0,
    });
    const ira = makeAccount({
      class: "tax_deferred",
      name: "IRA",
      taxTreatment: "tax_deferred",
      startingBalance: 500_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage, ira],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 5_000 })], // $60k/yr shortfall
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
      inflationRatePct: 0, // keep the floor flat at exactly $100k for a clean assertion
      moneyFlow: {
        splitOrder: [],
        drainOrder: [
          { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: null, minBalance: 100_000, minBalanceGrowthRatePct: null },
          { id: nanoid(), accountId: ira.id, startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
        ],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    // Brokerage only has $10k of room above its $100k floor -- covers $10k of
    // the $60k shortfall, then stops; the remaining $50k spills to the IRA.
    expect(year.accountBalances[brokerage.id]).toBeCloseTo(100_000, 0);
    expect(year.accountBalances[ira.id]).toBeCloseTo(500_000 - 50_000, 0);
  });

  it("raises the insufficient-funds warning when a floor blocks coverage with no other source", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const brokerage = makeAccount({
      class: "taxable_investment",
      name: "Brokerage",
      taxTreatment: "taxable",
      startingBalance: 110_000,
      growthRatePct: 0,
    });
    const scenario = makeScenario({
      accounts: [checking, brokerage],
      expenses: [makeExpense({ paymentAccountId: checking.id, amount: 5_000 })], // $60k/yr shortfall
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
      inflationRatePct: 0,
      moneyFlow: {
        splitOrder: [],
        // Only source, floored at $100k -- can only ever cover $10k of the $60k shortfall.
        drainOrder: [{ id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: null, minBalance: 100_000, minBalanceGrowthRatePct: null }],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    expect(result.warnings.some((w) => w.kind === "insufficient_funds" && w.year === 2026)).toBe(true);
    expect(result.years[0].accountBalances[brokerage.id]).toBeCloseTo(100_000, 0);
  });
});

describe("forecastScenario -- split order date windows and floor growth override", () => {
  it("only routes surplus to a split stop within its date window", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const buffer = makeAccount({ class: "cash", name: "Retirement Buffer", startingBalance: 0, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [checking, buffer],
      incomeSources: [makeIncome({ depositAccountId: checking.id, amount: 5_000 })],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
      moneyFlow: {
        // Buffer doesn't start absorbing surplus until 2027.
        splitOrder: [
          { id: nanoid(), accountId: buffer.id, kind: "percent_of_remainder", amount: null, pct: 1, maxBalance: null, maxBalanceGrowthRatePct: null, startDate: "2027-01-01", endDate: null },
        ],
        drainOrder: [],
        drainSplitMode: "priority_fill",
      },
    });
    const result = forecastScenario(scenario);
    const y2026 = result.years.find((y) => y.year === 2026)!;
    const y2027 = result.years.find((y) => y.year === 2027)!;

    // 2026: the stop isn't active yet -- all $60k of surplus stays in checking.
    expect(y2026.accountBalances[buffer.id]).toBeCloseTo(0, 0);
    expect(y2026.accountBalances[checking.id]).toBeCloseTo(60_000, 0);
    // 2027: the stop is active -- that year's $60k surplus routes to the buffer,
    // 2026's accumulated $60k stays behind in checking (untouched retroactively).
    expect(y2027.accountBalances[buffer.id]).toBeCloseTo(60_000, 0);
    expect(y2027.accountBalances[checking.id]).toBeCloseTo(60_000, 0);
  });

  it("uses the drain floor's own growth rate instead of inflation when one is set", () => {
    const runWith = (minBalanceGrowthRatePct: number | null) => {
      const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
      const brokerage = makeAccount({
        class: "taxable_investment",
        name: "Brokerage",
        taxTreatment: "taxable",
        startingBalance: 200_000,
        growthRatePct: 0,
      });
      const scenario = makeScenario({
        accounts: [checking, brokerage],
        expenses: [makeExpense({ paymentAccountId: checking.id, amount: 50_000 / 12 })], // ~$50k/yr shortfall
        startDate: "2026-01-01",
        horizonEndDate: "2027-12-31",
        inflationRatePct: 0.03,
        moneyFlow: {
          splitOrder: [],
          drainOrder: [
            { id: nanoid(), accountId: brokerage.id, startDate: null, endDate: null, splitPct: null, minBalance: 100_000, minBalanceGrowthRatePct },
          ],
          drainSplitMode: "priority_fill",
        },
      });
      const result = forecastScenario(scenario);
      return result.years.find((y) => y.year === 2027)!.accountBalances[brokerage.id];
    };

    // Year 1 draws the balance from 200k down to the (identical, year-0) 100k
    // floor's headroom without fully hitting it; year 2 is where the two
    // floors diverge: inflation grows it to 103k, the explicit override to
    // 110k, so the override leaves a visibly higher balance behind.
    const withInflationFloor = runWith(null);
    const withCustomFloor = runWith(0.10);
    expect(withInflationFloor).toBeCloseTo(103_000, 0);
    expect(withCustomFloor).toBeCloseTo(110_000, 0);
    expect(withCustomFloor).toBeGreaterThan(withInflationFloor);
  });
});

describe("forecastScenario -- cash-flow line item start dates", () => {
  it("tags each expense/income/contribution line item with its true first-posted date", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 0 });
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 0, isSurplusTarget: true, surplusTargetPriority: 1 });
    const rent = makeExpense({ paymentAccountId: checking.id, name: "Rent", amount: 2_000, startDate: "2026-01-01" });
    const carRepair = makeExpense({
      paymentAccountId: checking.id,
      name: "Car repair",
      amount: 3_000,
      frequency: "one_time",
      startDate: "2026-06-01",
    });
    const salary = makeIncome({ depositAccountId: checking.id, name: "Salary", amount: 10_000, startDate: "2026-01-01" });
    const scenario = makeScenario({
      accounts: [checking, savings],
      incomeSources: [salary],
      expenses: [rent, carRepair],
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const year = result.years[0];

    const rentItem = year.cashFlow.expenseByItem.find((i) => i.label === "Rent")!;
    const carItem = year.cashFlow.expenseByItem.find((i) => i.label === "Car repair")!;
    const salaryItem = year.cashFlow.incomeByItem.find((i) => i.label === "Salary")!;

    expect(rentItem.startDate).toBe("2026-01-01");
    expect(carItem.startDate).toBe("2026-06-01");
    expect(salaryItem.startDate).toBe("2026-01-01");
    // Chronological, not magnitude order: Rent ($24k/yr) outweighs the
    // one-time $3k Car repair, but Rent still starts first.
    expect(rentItem.startDate! < carItem.startDate!).toBe(true);
  });
});
