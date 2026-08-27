import { describe, expect, it } from "vitest";
import type { Account, Person } from "@/domain";
import { accountCashBalances } from "@/engine/portfolio/cash";
import { analyzePortfolio } from "@/engine/portfolio/metrics";
import { portfolioSchema } from "@/domain/portfolio";
import { buildDemoPortfolio } from "./demoPortfolio";

const PEOPLE: Person[] = [
  { id: "p-alex", name: "Alex", birthDate: "1990-05-15", retirementAge: 65, planningEndAge: 95 },
  { id: "p-jordan", name: "Jordan", birthDate: "1992-09-22", retirementAge: 63, planningEndAge: 95 },
];

function forecastAccount(id: string, name: string, ownerId: string | null, taxTreatment: Account["taxTreatment"]): Account {
  return {
    id,
    name,
    class: taxTreatment === "taxable" ? "taxable_investment" : "tax_deferred",
    category: "asset",
    ownerId,
    startingBalance: 1_000,
    growthRatePct: 0.06,
    taxTreatment,
    subjectToRMD: false,
  };
}

const FORECAST: Account[] = [
  forecastAccount("f-brokerage", "Joint Brokerage", null, "taxable"),
  forecastAccount("f-alex-401k", "Alex 401(k)", "p-alex", "tax_deferred"),
  forecastAccount("f-alex-roth", "Alex Roth IRA", "p-alex", "tax_free"),
  forecastAccount("f-jordan-401k", "Jordan 401(k)", "p-jordan", "tax_deferred"),
];

const TODAY = "2026-08-27";

describe("buildDemoPortfolio", () => {
  it("is a portfolio the app can load", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    expect(portfolioSchema.safeParse(demo).success).toBe(true);
    expect(demo.transactions.length).toBeGreaterThan(60);
  });

  it("gives every transaction a distinct id", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    expect(new Set(demo.transactions.map((tx) => tx.id)).size).toBe(demo.transactions.length);
  });

  it("links each account to its forecast counterpart without syncing into it", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    expect(demo.accounts.map((a) => [a.name, a.forecastAccountId])).toEqual([
      ["Joint Brokerage", "f-brokerage"],
      ["Alex 401(k)", "f-alex-401k"],
      ["Alex Roth IRA", "f-alex-roth"],
      ["Jordan 401(k)", "f-jordan-401k"],
    ]);
    // Linking is the point; writing fictional balances into a real plan is not.
    expect(demo.accounts.every((a) => a.syncToForecast === false)).toBe(true);
  });

  it("matches on owner and tax treatment when the names don't line up", () => {
    const renamed: Account[] = [
      forecastAccount("f-1", "Taxable investments", null, "taxable"),
      forecastAccount("f-2", "Workplace retirement", "p-alex", "tax_deferred"),
      forecastAccount("f-3", "Backdoor Roth", "p-alex", "tax_free"),
      forecastAccount("f-4", "Jordan's pension pot", "p-jordan", "tax_deferred"),
    ];
    const demo = buildDemoPortfolio(PEOPLE, renamed, TODAY);
    expect(demo.accounts.map((a) => a.forecastAccountId)).toEqual(["f-1", "f-2", "f-3", "f-4"]);
  });

  it("leaves an account unlinked rather than guessing when the plan has no match", () => {
    const demo = buildDemoPortfolio(PEOPLE, [], TODAY);
    expect(demo.accounts.every((a) => a.forecastAccountId === null)).toBe(true);
  });

  it("names its accounts after the household it was built for", () => {
    const others: Person[] = [
      { ...PEOPLE[0], id: "p-1", name: "Sam" },
      { ...PEOPLE[1], id: "p-2", name: "Robin" },
    ];
    const demo = buildDemoPortfolio(others, [], TODAY);
    expect(demo.accounts.map((a) => a.name)).toEqual([
      "Joint Brokerage",
      "Sam 401(k)",
      "Sam Roth IRA",
      "Robin 401(k)",
    ]);
  });

  it("gives a one-person household only the accounts that person has", () => {
    const demo = buildDemoPortfolio([PEOPLE[0]], FORECAST, TODAY);
    expect(demo.accounts.map((a) => a.name)).toEqual([
      "Joint Brokerage",
      "Alex 401(k)",
      "Alex Roth IRA",
    ]);
    expect(demo.transactions.every((tx) => demo.accounts.some((a) => a.id === tx.accountId))).toBe(true);
  });

  it("gives every open position a cost basis, so no return column reads as a dash", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    const { holdings } = analyzePortfolio(demo, {}, { asOf: TODAY });
    for (const holding of holdings.filter((h) => h.kind === "position")) {
      expect(holding.costBasis).toBeGreaterThan(0);
    }
  });

  it("replays without a single ledger warning", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    const analysis = analyzePortfolio(demo, {}, { asOf: TODAY });
    expect(analysis.warnings).toEqual([]);
  });

  it("never spends money the account doesn't hold", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    for (const [, cash] of accountCashBalances(demo, { asOf: TODAY })) {
      expect(cash.solvent).toBe(true);
      // A demo ledger that funds itself needs no inferred opening balance.
      expect(cash.implied).toBe(0);
      expect(cash.balance).toBeGreaterThanOrEqual(0);
    }
  });

  it("has something in every panel: open positions, closed lots, and income", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    const analysis = analyzePortfolio(demo, {}, { asOf: TODAY });
    expect(analysis.holdings.filter((h) => h.kind === "position").length).toBeGreaterThan(5);
    expect(analysis.closedLots.filter((lot) => lot.taxable).length).toBeGreaterThan(3);
    expect(analysis.summary.income).toBeGreaterThan(0);
    // Both signs, so the winners/losers filter has something to filter.
    expect(analysis.closedLots.some((lot) => lot.gain > 0)).toBe(true);
    expect(analysis.closedLots.some((lot) => lot.gain < 0)).toBe(true);
  });

  it("realizes both a short-term and a long-term gain, so neither tile reads zero", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    const { summary } = analyzePortfolio(demo, {}, { asOf: TODAY });
    expect(summary.realizedShortTerm).not.toBe(0);
    expect(summary.realizedLongTerm).not.toBe(0);
  });

  it("realizes something in the current year, whenever that is", () => {
    for (const today of ["2026-08-27", "2031-01-04", "2044-12-30"]) {
      const demo = buildDemoPortfolio(PEOPLE, FORECAST, today);
      const analysis = analyzePortfolio(demo, {}, { asOf: today });
      expect(analysis.summary.realizedGainYtd).not.toBe(0);
    }
  });

  it("spans several asset classes, including one holding split across two", () => {
    const demo = buildDemoPortfolio(PEOPLE, FORECAST, TODAY);
    const classes = new Set(demo.securities.map((s) => s.assetClass));
    expect(classes.size).toBeGreaterThanOrEqual(4);
    const split = demo.securities.filter((s) => s.exposures.length > 1);
    expect(split).toHaveLength(1);
    expect(split[0].exposures.reduce((sum, e) => sum + e.weight, 0)).toBeCloseTo(1, 10);
  });
});
