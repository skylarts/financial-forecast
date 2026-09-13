import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { forecastSettingsSchema, DEFAULT_HEALTHCARE_SETTINGS, type Account } from "@/domain";
import { forecastScenario, projectScenario } from "./forecastScenario";
import { deriveDrainOrder, unreachableAccounts, accountsInStrategyOrder } from "./strategy";
import { applyStress } from "./stress";
import { firstShortfallYear, holdsThroughLabel } from "./planHealth";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";

/** Guards the withdrawal strategy presets, the cash buffer, the plan-wide return, the healthcare model, and the stress presets. */

const person = (birthDate: string, retirementAge = 65) => ({ id: nanoid(), name: "P", birthDate, retirementAge, planningEndAge: 95 });

describe("settings: withdrawal strategy default", () => {
  const base = { startDate: "2026-01-01", horizonEndDate: "2087-12-31", inflationRatePct: 0.03 };
  it("keeps a hand-built drain order as custom and gives an empty one the conventional preset", () => {
    const stop = { id: "s", accountId: "a", kind: "percent_of_remainder", amount: null, pct: 1, startDate: null, endDate: null };
    expect(forecastSettingsSchema.parse({ ...base, moneyFlow: { splitOrder: [], drainOrder: [stop] } }).withdrawalStrategy).toBe("custom");
    expect(forecastSettingsSchema.parse({ ...base }).withdrawalStrategy).toBe("conventional");
    expect(forecastSettingsSchema.parse({ ...base, withdrawalStrategy: "pro_rata" }).withdrawalStrategy).toBe("pro_rata");
  });
  it("fills in the healthcare block, the buffer, and the plan return", () => {
    const s = forecastSettingsSchema.parse(base);
    expect(s.healthcare.enabled).toBe(false);
    expect(s.healthcare.marketplace.premiumTaxCredit).toBe(true);
    expect(s.healthcare.cobra.months).toBe(18);
    expect(s.cashBufferTarget).toBeNull();
    expect(s.planReturnRatePct).toBeNull();
    const on = forecastSettingsSchema.parse({ ...base, healthcare: { enabled: true, medicare: { irmaa: false } } });
    expect(on.healthcare.enabled).toBe(true);
    expect(on.healthcare.medicare.irmaa).toBe(false);
    expect(on.healthcare.medicare.partDMonthlyPremium).toBe(45);
  });
});

describe("withdrawal strategy presets", () => {
  const owner = person("1970-01-01");
  const cash = makeAccount({ class: "cash", name: "Checking", startingBalance: 5_000 });
  const brokerage = makeAccount({ class: "taxable_investment", name: "Brokerage", startingBalance: 100_000 });
  const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 300_000, ownerId: owner.id });
  const roth = makeAccount({ class: "tax_free", name: "Roth", startingBalance: 50_000, ownerId: owner.id });
  const home = makeAccount({ class: "real_estate", name: "Home", startingBalance: 400_000 });
  const hsa = makeAccount({ class: "hsa", name: "HSA", startingBalance: 10_000 });
  const excluded = makeAccount({ class: "taxable_investment", name: "Kid's UTMA", startingBalance: 10_000, isExcluded: true });
  const accounts: Account[] = [roth, home, ira, hsa, brokerage, excluded, cash];

  it("orders accounts by tier and skips what a preset never touches", () => {
    expect(accountsInStrategyOrder("conventional", accounts).map((a) => a.name)).toEqual(["Checking", "Brokerage", "IRA", "Roth"]);
    expect(accountsInStrategyOrder("tax_deferred_first", accounts).map((a) => a.name)).toEqual(["Checking", "IRA", "Brokerage", "Roth"]);
    expect(deriveDrainOrder("conventional", accounts).every((s) => s.pct === 1 && s.kind === "percent_of_remainder")).toBe(true);
  });

  it("lists the accounts a custom order leaves unreachable", () => {
    const custom = deriveDrainOrder("conventional", accounts).filter((s) => s.accountId !== roth.id);
    expect(unreachableAccounts(custom, accounts).map((a) => a.name)).toEqual(["Roth"]);
  });

  it("covers a shortfall with an empty drain order under a preset, and not under custom", () => {
    const build = (strategy: "conventional" | "custom") =>
      makeScenario({
        accounts: [cash, brokerage, ira, roth],
        people: [owner],
        expenses: [makeExpense({ amount: 4_000 })],
        moneyFlow: { splitOrder: [], drainOrder: [] },
        withdrawalStrategy: strategy,
      });
    const preset = forecastScenario(build("conventional"));
    const custom = forecastScenario(build("custom"));
    expect(firstShortfallYear(custom)).toBe(2026);
    expect(firstShortfallYear(preset)).toBeNull();
    expect(holdsThroughLabel(preset)).toBe("End of plan");
    // Conventional: checking first, then the brokerage; the IRA is untouched
    // while the brokerage can still pay.
    const y = preset.years[0];
    expect(y.accountBalances[cash.id]).toBe(0);
    expect(y.accountBalances[brokerage.id]).toBeCloseTo(100_000 - (48_000 - 5_000), 0);
    expect(y.accountBalances[ira.id]).toBe(300_000);
  });

  it("draws from every investment account in proportion to its balance under pro_rata", () => {
    const scenario = makeScenario({
      accounts: [brokerage, ira, roth],
      people: [person("1950-01-01")], // past 59½, no penalty; RMD-free (subjectToRMD false)
      expenses: [makeExpense({ amount: 4_500 })],
      moneyFlow: { splitOrder: [], drainOrder: [] },
      withdrawalStrategy: "pro_rata",
    });
    const r = forecastScenario(scenario); // untaxed, so draws equal balances moved
    const y = r.years[0];
    const drawn = (id: string) => y.cashFlow.withdrawalsByAccount.find((w) => w.id === id)?.net ?? 0;
    const total = drawn(brokerage.id) + drawn(ira.id) + drawn(roth.id);
    expect(total).toBeCloseTo(54_000, 0);
    // 100k : 300k : 50k = 2 : 6 : 1 of the shortfall.
    expect(drawn(brokerage.id) / total).toBeCloseTo(100 / 450, 2);
    expect(drawn(ira.id) / total).toBeCloseTo(300 / 450, 2);
    expect(drawn(roth.id) / total).toBeCloseTo(50 / 450, 2);
  });
});

describe("cash buffer target", () => {
  it("keeps Extra Savings topped up to the target instead of at zero", () => {
    const savings = makeAccount({ class: "cash", name: "Savings", startingBalance: 100_000 });
    const scenario = makeScenario({
      accounts: [savings],
      expenses: [makeExpense({ amount: 2_000 })],
      moneyFlow: { splitOrder: [], drainOrder: [] },
      withdrawalStrategy: "conventional",
      cashBufferTarget: 10_000,
    });
    const r = forecastScenario(scenario);
    const hub = r.accounts.find((a) => a.isExtraSavings)!;
    for (const m of r.months) expect(m.accountBalances[hub.id]).toBeCloseTo(10_000, 0);
    expect(r.years[0].accountBalances[savings.id]).toBeCloseTo(100_000 - 24_000 - 10_000, 0);
    expect(firstShortfallYear(r)).toBeNull();
  });
});

describe("plan-wide expected return", () => {
  const cash = makeAccount({ class: "cash", name: "Savings", startingBalance: 10_000, growthRatePct: 0.02 });
  const fund = makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 100_000, growthRatePct: 0.05 });
  // The engine skips growth in an account's opening month, so a first year
  // compounds eleven months of the annual rate.
  const firstYear = (balance: number, rate: number) => balance * Math.pow(1 + rate, 11 / 12);
  it("replaces every investment account's own rate while set, and leaves cash alone", () => {
    const r = forecastScenario(makeScenario({ accounts: [cash, fund], planReturnRatePct: 0.1 }));
    expect(r.years[0].accountBalances[fund.id]).toBeCloseTo(firstYear(100_000, 0.1), 0);
    expect(r.years[0].accountBalances[cash.id]).toBeCloseTo(firstYear(10_000, 0.02), 0);
  });
  it("is off by default so the account's own rate applies", () => {
    const r = forecastScenario(makeScenario({ accounts: [cash, fund] }));
    expect(r.years[0].accountBalances[fund.id]).toBeCloseTo(firstYear(100_000, 0.05), 0);
  });
  it("takes the stress options: a return haircut and a one-year crash", () => {
    const s = makeScenario({ accounts: [cash, fund], horizonEndDate: "2027-12-31" });
    const haircut = forecastScenario(s, undefined, { returnAdjustment: -0.02 });
    expect(haircut.years[0].accountBalances[fund.id]).toBeCloseTo(firstYear(100_000, 0.03), 0);
    const crash = forecastScenario(s, undefined, { yearReturnOverride: { year: 2026, ratePct: -0.3 } });
    const afterCrash = firstYear(100_000, -0.3);
    expect(crash.years[0].accountBalances[fund.id]).toBeCloseTo(afterCrash, 0);
    expect(crash.years[1].accountBalances[fund.id]).toBeCloseTo(afterCrash * 1.05, 0);
  });
});

describe("healthcare model", () => {
  const flat = { ...DEFAULT_HEALTHCARE_SETTINGS, enabled: true, costGrowthRatePct: 0 };
  const cashAccount = () => makeAccount({ class: "cash", name: "Savings", startingBalance: 500_000 });
  const item = (r: ReturnType<typeof forecastScenario>, id: string) => r.years[0].cashFlow.expenseByItem.find((i) => i.id === id)?.amount ?? 0;

  it("charges Medicare, an income surcharge from two-year-old income, and out-of-pocket costs at 65+", () => {
    const p = person("1958-06-01");
    const base = makeScenario({ accounts: [cashAccount()], people: [p], healthcare: { ...flat, medicare: { ...flat.medicare, irmaa: false } } });
    const r = forecastScenario(base);
    expect(item(r, `healthcare:medicare:${p.id}`)).toBeCloseTo((202.9 + 45 + 150) * 12, 0);
    expect(item(r, `healthcare:oop:${p.id}`)).toBeCloseTo(2_500, 0);
    expect(item(r, `healthcare:irmaa:${p.id}`)).toBe(0);
    // With IRMAA on and a large prior income: tier 1 for a single filer.
    const rates = new Map([[2026, { ordinaryMarginalRate: 0.22, ordinaryWithholdingRate: 0.2, ltcgMarginalRate: 0.15, ssTaxableFraction: 0.5, agiEstimate: 120_000, acaMagiEstimate: 120_000 }]]);
    const withIrmaa = forecastScenario(makeScenario({ accounts: [cashAccount()], people: [p], filingStatus: "single", healthcare: flat }), rates);
    expect(item(withIrmaa, `healthcare:irmaa:${p.id}`)).toBeCloseTo((81.2 + 14.5) * 12, 0);
  });

  it("uses the employer premium while a salary runs, and the marketplace once it stops", () => {
    const p = person("1975-03-01", 51); // retires at 51: 2026-03-01
    const salary = makeIncome({ name: "Salary", amount: 6_000, ownerId: p.id });
    const scenario = makeScenario({
      accounts: [cashAccount()],
      people: [p],
      incomeSources: [salary],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-07-01", personId: p.id, retirementAge: 51 }],
      healthcare: {
        ...flat,
        workingMonthlyPremiumPerPerson: 100,
        marketplace: { ...flat.marketplace, benchmarkMonthlyPremiumPerPerson: 700, ageRated: false, premiumTaxCredit: false },
      },
    });
    const r = forecastScenario(scenario);
    expect(item(r, `healthcare:employer:${p.id}`)).toBeCloseTo(600, 0); // Jan-Jun
    expect(item(r, "healthcare:marketplace")).toBeCloseTo(700 * 6, 0); // Jul-Dec
    expect(item(r, `healthcare:oop:${p.id}`)).toBeCloseTo(2_000, 0);
  });

  it("runs COBRA for the set months after the last paycheck, then the marketplace", () => {
    const p = person("1975-03-01", 51);
    const scenario = makeScenario({
      accounts: [cashAccount()],
      people: [p],
      incomeSources: [makeIncome({ name: "Salary", amount: 6_000, ownerId: p.id })],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-04-01", personId: p.id, retirementAge: 51 }],
      healthcare: {
        ...flat,
        retiredCoverage: "cobra_then_marketplace",
        cobra: { months: 3, monthlyPremiumPerPerson: 900 },
        marketplace: { ...flat.marketplace, benchmarkMonthlyPremiumPerPerson: 700, ageRated: false, premiumTaxCredit: false },
      },
    });
    const r = forecastScenario(scenario);
    expect(item(r, `healthcare:cobra:${p.id}`)).toBeCloseTo(900 * 3, 0); // Apr-Jun
    expect(item(r, "healthcare:marketplace")).toBeCloseTo(700 * 6, 0); // Jul-Dec
  });

  it("ages the marketplace premium and applies the premium credit against the plan's own income", () => {
    const p = person("1966-01-01"); // 60 at the plan start
    const spouse = { ...person("1968-01-01"), name: "S" };
    const ira = makeAccount({ class: "tax_deferred", name: "IRA", startingBalance: 1_000_000, ownerId: p.id, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [ira],
      people: [p, spouse],
      filingStatus: "marriedFilingJointly",
      expenses: [makeExpense({ amount: 4_000 })],
      moneyFlow: { splitOrder: [], drainOrder: [] },
      withdrawalStrategy: "conventional",
      horizonEndDate: "2027-12-31",
      healthcare: { ...flat, marketplace: { ...flat.marketplace, benchmarkMonthlyPremiumPerPerson: 1_000, ageRated: true, premiumTaxCredit: true } },
    });
    const r = projectScenario(scenario);
    const premium = item(r, "healthcare:marketplace");
    // Roughly $48k of spending plus the premium and tax comes out of the
    // IRA: about three times the poverty line for two, so the couple pays
    // near 9.5% of income (~$6k) instead of the $24k list price.
    expect(premium).toBeGreaterThan(3_000);
    expect(premium).toBeLessThan(10_000);
    expect(r.years[0].cashFlow.acaModifiedAgi).toBeGreaterThan(45_000);
    // Age rating: the second year is pricier than the first by the curve's step from 60 to 61.
    const premium2027 = r.years[1].cashFlow.expenseByItem.find((i) => i.id === "healthcare:marketplace")?.amount ?? 0;
    expect(premium2027).toBeGreaterThan(0);
  });

  it("pays out-of-pocket costs from an HSA while it lasts", () => {
    const p = person("1975-01-01");
    const hsa = makeAccount({ class: "hsa", name: "HSA", startingBalance: 1_500, growthRatePct: 0, ownerId: p.id });
    const scenario = makeScenario({
      accounts: [cashAccount(), hsa],
      people: [p],
      healthcare: { ...flat, retiredCoverage: "none", outOfPocket: { ...flat.outOfPocket, preMedicareAnnualPerPerson: 2_400 } },
    });
    const r = forecastScenario(scenario);
    expect(r.years[0].accountBalances[hsa.id]).toBe(0);
    expect(item(r, `healthcare:oop:${p.id}`)).toBeCloseTo(2_400, 0);
  });

  it("charges nothing when the model is off", () => {
    const r = forecastScenario(makeScenario({ accounts: [cashAccount()], people: [person("1958-06-01")] }));
    expect(r.years[0].cashFlow.expenseByItem.some((i) => i.id.startsWith("healthcare:"))).toBe(false);
  });
});

describe("stress presets", () => {
  const owner = person("1980-01-01", 60);
  const fund = makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 500_000, growthRatePct: 0.06 });
  const ss = makeIncome({ name: "SS", amount: 2_500, category: "social_security", ownerId: owner.id, startDate: "2047-01-01" });
  const scenario = makeScenario({
    accounts: [fund],
    people: [owner],
    incomeSources: [ss],
    events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2040-01-01", personId: owner.id, retirementAge: 60 }],
    horizonEndDate: "2050-12-31",
  });

  it("builds each preset from the base plan without touching it", () => {
    expect(applyStress(scenario, "lower_returns").options.returnAdjustment).toBe(-0.02);
    expect(applyStress(scenario, "bear_at_retirement").options.yearReturnOverride).toEqual({ year: 2040, ratePct: -0.3 });
    expect(applyStress(scenario, "higher_inflation").scenario.settings.inflationRatePct).toBeCloseTo(0.01, 6);
    const longer = applyStress(scenario, "live_longer").scenario;
    expect(longer.household.people[0].planningEndAge).toBe(100);
    expect(longer.settings.horizonEndDate).toBe("2055-12-31");
    // The base plan is never mutated by building a preset from it.
    expect(scenario.household.people[0].planningEndAge).toBe(95);
    expect(scenario.settings.inflationRatePct).toBe(0);
  });

  it("lower returns end lower than the base plan", () => {
    const base = projectScenario(scenario);
    const stressed = applyStress(scenario, "lower_returns");
    const worse = projectScenario(stressed.scenario, stressed.options);
    expect(worse.kpis.netWorthAtEnd).toBeLessThan(base.kpis.netWorthAtEnd);
  });
});
