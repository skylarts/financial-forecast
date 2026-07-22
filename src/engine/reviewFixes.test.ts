import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";

/**
 * Regression tests for the 2026-07 full review's findings -- each `describe`
 * names the finding it guards. See the review report / PR description.
 */

describe("review C1 -- replaceHousingExpenses must not kill the NEW home's own mortgage & costs", () => {
  it("amortizes the newly-bought home's mortgage and posts its ownership costs", () => {
    const checking = makeAccount({ class: "cash", name: "Checking", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const newHome = makeAccount({
      class: "real_estate", name: "New Home",
      startingBalance: 500_000, growthRatePct: 0, propertyGrowthRatePct: 0,
      propertyTaxRatePct: 0.01, homeInsuranceRatePct: 0.005, maintenanceRatePct: 0.01,
      startDate: "2026-07-01",
    });
    const newMortgage = makeAccount({
      class: "mortgage", name: "New Mortgage",
      startingBalance: 400_000, growthRatePct: 0,
      startDate: "2026-07-01",
      loanTerms: {
        originalPrincipal: 400_000, originationDate: "2026-07-01",
        annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: newHome.id,
      },
    });
    const rent = makeExpense({ category: "housing", amount: 2_000, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [checking, { ...newHome, linkedLiabilityId: newMortgage.id }, newMortgage],
      expenses: [rent],
      events: [
        {
          id: nanoid(), type: "buy_home", name: "Buy new home", startDate: "2026-07-01",
          purchasePrice: 500_000, downPaymentAmount: 100_000,
          downPaymentFromAccountId: checking.id, realEstateAccountId: newHome.id,
          replaceHousingExpenses: true,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2028-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!;
    const y2028 = result.years.find((y) => y.year === 2028)!;

    // ~12 payments of ~$2,398 -- the new mortgage MUST keep amortizing.
    const mortgagePayments = y2027.cashFlow.expenseByItem.find((i) => i.id === newMortgage.id);
    expect(mortgagePayments?.amount ?? 0).toBeGreaterThan(25_000);
    expect(y2028.accountBalances[newMortgage.id]).toBeLessThan(y2027.accountBalances[newMortgage.id]);

    // Its own property tax / insurance / maintenance must post (~$12.5k/yr).
    const ownership = y2027.cashFlow.expenseByItem.find((i) => i.id === `${newHome.id}:ownership_costs`);
    expect(ownership?.amount ?? 0).toBeCloseTo(12_500, -3);

    // While the old category=housing expense (rent) still stops.
    expect(y2027.cashFlow.expenseByItem.some((i) => i.id === rent.id)).toBe(false);
  });
});

describe("review C2 -- year-end tax true-up settles withholding onto the exact bill", () => {
  function retireeDrawdownScenario() {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const ira = makeAccount({
      class: "tax_deferred", name: "Trad IRA", taxTreatment: "tax_deferred",
      startingBalance: 2_000_000, growthRatePct: 0, withdrawalPriority: 1,
    });
    const spend = makeExpense({ amount: 80_000 / 12, frequency: "monthly", growthRatePct: 0 });
    return makeScenario({
      accounts: [hub, ira],
      expenses: [spend],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
      filingStatus: "marriedFilingJointly",
    });
  }

  it("the household's actual cash tax equals the exact bracket bill (settlement refunds over-withholding)", () => {
    const result = projectScenario(retireeDrawdownScenario());
    const y = result.years[0];
    // Withholding (marginal rate on every dollar) minus the refund must land
    // exactly on the bracket-computed bill.
    expect(y.cashFlow.withdrawalTaxes - y.cashFlow.taxSettlement).toBeCloseTo(y.cashFlow.federalTaxTotal, 2);
    // And the over-withholding was material -- the refund is real money.
    expect(y.cashFlow.taxSettlement).toBeGreaterThan(1_000);
    // The refund lands back in the hub, visible in the ledger.
    expect(result.ledger.some((e) => e.kind === "tax_settlement")).toBe(true);
  });

  it("the reconcile identity holds exactly with the new settlement & withholding fields", () => {
    const result = projectScenario(retireeDrawdownScenario());
    for (const y of result.years) {
      const cf = y.cashFlow;
      const derived =
        cf.operatingCashFlow -
        cf.incomeTaxWithheldFromCash +
        cf.withdrawalsToCashNet +
        cf.taxSettlement -
        cf.afterTaxContributionTotal -
        cf.surplusRouted +
        cf.cashInterest +
        cf.otherAccountActivity;
      expect(derived).toBeCloseTo(cf.netCashFlow, 4);
    }
  });

  it("identity also holds with gross Social Security + pension withholding on the hub", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const ira = makeAccount({
      class: "tax_deferred", name: "IRA", taxTreatment: "tax_deferred",
      startingBalance: 1_000_000, growthRatePct: 0, withdrawalPriority: 1,
    });
    const ss = makeIncome({ name: "SS", category: "social_security", amount: 2_500, frequency: "monthly", growthRatePct: 0 });
    const pension = makeIncome({ name: "Pension", category: "pension", amount: 2_000, frequency: "monthly", growthRatePct: 0 });
    const spend = makeExpense({ amount: 9_000, frequency: "monthly", growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [hub, ira],
      incomeSources: [ss, pension],
      expenses: [spend],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = projectScenario(scenario);
    for (const y of result.years) {
      const cf = y.cashFlow;
      const derived =
        cf.operatingCashFlow -
        cf.incomeTaxWithheldFromCash +
        cf.withdrawalsToCashNet +
        cf.taxSettlement -
        cf.afterTaxContributionTotal -
        cf.surplusRouted +
        cf.cashInterest +
        cf.otherAccountActivity;
      expect(derived).toBeCloseTo(cf.netCashFlow, 4);
      expect(cf.withdrawalTaxes - cf.taxSettlement).toBeCloseTo(cf.federalTaxTotal, 2);
    }
  });
});

describe("review C3 -- money sent to a liability pays it down (never grows it)", () => {
  it("a transfer into a mortgage reduces the amount owed", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const mortgage = makeAccount({
      class: "mortgage", name: "Mortgage", startingBalance: 200_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 200_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360 },
    });
    const base = {
      accounts: [hub, mortgage],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    };
    const withTransfer = forecastScenario(
      makeScenario({
        ...base,
        events: [
          {
            id: nanoid(), type: "custom_transfer", name: "Extra payoff",
            startDate: "2026-06-01", amount: 10_000, frequency: "one_time",
            fromAccountId: hub.id, toAccountId: mortgage.id,
          },
        ],
      })
    );
    const baseline = forecastScenario(makeScenario(base));
    const y = withTransfer.years[0];
    const yb = baseline.years[0];
    // ~$10k lower balance than baseline (plus a little interest saved).
    expect(y.accountBalances[mortgage.id]).toBeLessThan(yb.accountBalances[mortgage.id] - 9_500);
    // Net worth improves vs baseline (interest saved), never craters.
    expect(y.netWorthNominal).toBeGreaterThanOrEqual(yb.netWorthNominal - 1);
  });

  it("overpaying a liability returns the excess to the hub instead of vanishing", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 50_000, growthRatePct: 0 });
    const loan = makeAccount({
      class: "loan", name: "Car loan", startingBalance: 5_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 5_000, originationDate: "2026-01-01", annualInterestRatePct: 0, termMonths: 60 },
    });
    const scenario = makeScenario({
      accounts: [hub, loan],
      events: [
        {
          id: nanoid(), type: "custom_transfer", name: "Payoff",
          startDate: "2026-02-01", amount: 8_000, frequency: "one_time",
          fromAccountId: hub.id, toAccountId: loan.id,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const result = forecastScenario(scenario);
    const y = result.years[0];
    expect(y.accountBalances[loan.id]).toBeCloseTo(0, 1);
    // Hub paid 8k out but got ~3.1k back (loan had already amortized a bit).
    expect(y.accountBalances[hub.id]).toBeGreaterThan(44_500);
    // Nothing vanished: net worth ≈ 50,000 - 5,000 (loan was debt all along).
    expect(y.netWorthNominal).toBeCloseTo(45_000, -1);
  });
});

describe("review M4/M5 -- RMD toggle and SECURE 2.0 start age", () => {
  function rmdScenario(birthDate: string, rmdEnabled: boolean, horizonEndDate = "2026-12-31") {
    const personId = nanoid();
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const ira = makeAccount({
      class: "tax_deferred", name: "IRA", taxTreatment: "tax_deferred",
      startingBalance: 500_000, growthRatePct: 0, subjectToRMD: true, ownerId: personId,
    });
    const scenario = makeScenario({
      accounts: [hub, ira],
      people: [{ id: personId, name: "P", birthDate, retirementAge: 65, planningEndAge: 99 }],
      startDate: "2025-01-01",
      horizonEndDate,
    });
    scenario.settings.rmdEnabled = rmdEnabled;
    return scenario;
  }

  it("settings.rmdEnabled=false actually disables RMDs", () => {
    // Born 1950 -> 76 in 2026, RMD-age by any rule.
    const result = forecastScenario(rmdScenario("1950-06-01", false));
    expect(result.years.every((y) => y.cashFlow.rmdTotal === 0)).toBe(true);
  });

  it("born 1950s: RMDs start at 73; born 1960+: not until 75", () => {
    // Born 1953: turns 73 in 2026 -> RMD fires.
    const on = forecastScenario(rmdScenario("1953-06-01", true));
    expect(on.years.find((y) => y.year === 2026)!.cashFlow.rmdTotal).toBeGreaterThan(0);

    // Born 1960: 73 in 2033 -- NO RMD; first RMD in 2035 at 75.
    const later = forecastScenario(rmdScenario("1960-06-01", true, "2036-12-31"));
    expect(later.years.find((y) => y.year === 2033)!.cashFlow.rmdTotal).toBe(0);
    expect(later.years.find((y) => y.year === 2034)!.cashFlow.rmdTotal).toBe(0);
    expect(later.years.find((y) => y.year === 2035)!.cashFlow.rmdTotal).toBeGreaterThan(0);
  });
});

describe("review M6 -- startingCostBasis drives embedded-gain taxation", () => {
  it("realizes more gains when the account starts with embedded gains", () => {
    const build = (startingCostBasis?: number) => {
      const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
      const brokerage = makeAccount({
        class: "taxable_investment", name: "Brokerage", taxTreatment: "taxable",
        startingBalance: 500_000, startingCostBasis, growthRatePct: 0, withdrawalPriority: 1,
      });
      const spend = makeExpense({ amount: 5_000, frequency: "monthly", growthRatePct: 0 });
      return projectScenario(
        makeScenario({ accounts: [hub, brokerage], expenses: [spend], startDate: "2026-01-01", horizonEndDate: "2026-12-31" })
      );
    };
    const noGains = build(undefined); // default: whole balance is basis
    const halfGains = build(250_000); // half the balance is unrealized gain
    expect(noGains.years[0].cashFlow.capitalGainsRealized).toBeCloseTo(0, 2);
    expect(halfGains.years[0].cashFlow.capitalGainsRealized).toBeGreaterThan(20_000);
  });
});

describe("review M7 -- 10% early-withdrawal penalty before 59½", () => {
  function earlyScenario(noEarlyWithdrawalPenalty: boolean) {
    const personId = nanoid();
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const k401 = makeAccount({
      class: "tax_deferred", name: "401k", taxTreatment: "tax_deferred",
      startingBalance: 1_000_000, growthRatePct: 0, withdrawalPriority: 1,
      ownerId: personId, noEarlyWithdrawalPenalty,
    });
    const spend = makeExpense({ amount: 6_000, frequency: "monthly", growthRatePct: 0 });
    return projectScenario(
      makeScenario({
        accounts: [hub, k401],
        expenses: [spend],
        // Owner is 52 -- withdrawals are penalized unless exempted.
        people: [{ id: personId, name: "P", birthDate: "1974-01-01", retirementAge: 52, planningEndAge: 95 }],
        startDate: "2026-01-01",
        horizonEndDate: "2026-12-31",
      })
    );
  }

  it("charges the penalty, reports it as a tax component, and warns", () => {
    const result = earlyScenario(false);
    const y = result.years[0];
    const penalty = y.cashFlow.federalTaxByComponent.find((c) => c.key === "early_withdrawal_penalty");
    expect(penalty?.amount ?? 0).toBeGreaterThan(6_000); // ≈10% of ~$72k+ gross draws
    expect(result.warnings.some((w) => w.kind === "early_withdrawal_penalty")).toBe(true);
    // Exact-bill invariant still holds with the penalty included.
    expect(y.cashFlow.withdrawalTaxes - y.cashFlow.taxSettlement).toBeCloseTo(y.cashFlow.federalTaxTotal, 2);
  });

  it("the 72(t)/rule-of-55 exemption flag suppresses it", () => {
    const result = earlyScenario(true);
    const y = result.years[0];
    expect(y.cashFlow.federalTaxByComponent.some((c) => c.key === "early_withdrawal_penalty")).toBe(false);
    expect(result.warnings.some((w) => w.kind === "early_withdrawal_penalty")).toBe(false);
  });
});

describe("review -- blank (null) growth rates default to the plan's inflation rate", () => {
  it("an expense with null growth keeps pace with inflation", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 1_000_000, growthRatePct: 0 });
    const spend = makeExpense({ amount: 1_000, frequency: "monthly", growthRatePct: null });
    const result = forecastScenario(
      makeScenario({ accounts: [hub], expenses: [spend], inflationRatePct: 0.03, startDate: "2026-01-01", horizonEndDate: "2027-12-31" })
    );
    const [y1, y2] = result.years;
    expect(y2.cashFlow.totalExpenses / y1.cashFlow.totalExpenses).toBeCloseTo(1.03, 2);
  });

  it("an account with null growth grows at inflation; explicit 0 stays flat", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 0, growthRatePct: 0 });
    const inflating = makeAccount({ class: "cash", name: "HYSA", startingBalance: 100_000, growthRatePct: null });
    const flat = makeAccount({ class: "cash", name: "Checking", startingBalance: 100_000, growthRatePct: 0 });
    const result = forecastScenario(
      makeScenario({ accounts: [hub, inflating, flat], inflationRatePct: 0.03, startDate: "2026-01-01", horizonEndDate: "2026-12-31" })
    );
    const y = result.years[0];
    // ~11 months of a 3%-annual monthly-compounded rate (no growth in the creation month).
    expect(y.accountBalances[inflating.id]).toBeGreaterThan(102_500);
    expect(y.accountBalances[flat.id]).toBeCloseTo(100_000, 2);
  });
});

describe("review M13 -- computed home-sale proceeds (sellingCostsPct mode)", () => {
  it("credits simulated value × (1−costs) − mortgage payoff, and retires both accounts", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const home = makeAccount({
      class: "real_estate", name: "Home", startingBalance: 400_000, growthRatePct: 0, propertyGrowthRatePct: 0,
    });
    const mortgage = makeAccount({
      class: "mortgage", name: "Mortgage", startingBalance: 200_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 200_000, originationDate: "2026-01-01", annualInterestRatePct: 0.06, termMonths: 360, linkedAssetId: home.id },
    });
    const scenario = makeScenario({
      accounts: [hub, { ...home, linkedLiabilityId: mortgage.id }, mortgage],
      events: [
        {
          id: nanoid(), type: "sell_home", name: "Sell", startDate: "2027-06-01",
          realEstateAccountId: home.id, netProceeds: 0, sellingCostsPct: 0.06, proceedsAccountId: null,
        },
      ],
      startDate: "2026-01-01",
      horizonEndDate: "2027-12-31",
    });
    const result = forecastScenario(scenario);
    const y2027 = result.years.find((y) => y.year === 2027)!;
    const sale = result.ledger.find((e) => e.kind === "home_sale");
    expect(sale).toBeDefined();
    // 400k × 0.94 = 376k, minus a ~197.5k remaining mortgage → ~178.5k.
    expect(sale!.amount).toBeGreaterThan(170_000);
    expect(sale!.amount).toBeLessThan(185_000);
    expect(y2027.accountBalances[home.id]).toBeCloseTo(0, 2);
    expect(y2027.accountBalances[mortgage.id]).toBeCloseTo(0, 2);
  });
});

describe("review M11 -- credit cards amortize when given loan terms, warn when not", () => {
  it("a credit card with loanTerms pays down like a loan", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const card = makeAccount({
      class: "credit_card", name: "Card", startingBalance: 10_000, growthRatePct: 0,
      loanTerms: { originalPrincipal: 10_000, originationDate: "2026-01-01", annualInterestRatePct: 0.22, termMonths: 24 },
    });
    const result = forecastScenario(
      makeScenario({ accounts: [hub, card], startDate: "2026-01-01", horizonEndDate: "2026-12-31" })
    );
    const y = result.years[0];
    expect(y.accountBalances[card.id]).toBeLessThan(7_000);
    expect(result.warnings.some((w) => w.kind === "unamortized_debt")).toBe(false);
  });

  it("a carried balance with no terms produces an unamortized_debt warning", () => {
    const hub = makeAccount({ class: "cash", name: "Extra Savings", isSpendingAccount: true, startingBalance: 100_000, growthRatePct: 0 });
    const card = makeAccount({ class: "credit_card", name: "Card", startingBalance: 10_000, growthRatePct: 0 });
    const result = forecastScenario(
      makeScenario({ accounts: [hub, card], startDate: "2026-01-01", horizonEndDate: "2026-12-31" })
    );
    expect(result.warnings.some((w) => w.kind === "unamortized_debt" && w.accountId === card.id)).toBe(true);
  });
});
