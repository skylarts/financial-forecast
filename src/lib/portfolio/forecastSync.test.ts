import { describe, expect, it } from "vitest";
import type { Portfolio, PortfolioAccount, Transaction } from "@/domain/portfolio";
import type { PriceMap } from "@/engine/portfolio/metrics";
import { makeAccount } from "@/engine/testHelpers";
import { pendingForecastPushes } from "./forecastSync";

function account(patch: Partial<PortfolioAccount> & { id: string }): PortfolioAccount {
  return {
    name: "Brokerage",
    institution: "",
    type: "taxable",
    forecastAccountId: null,
    syncToForecast: true,
    ownerId: null,
    openingCashBalance: 0,
    ...patch,
  };
}

let seq = 0;
function buy(patch: Partial<Transaction> & { accountId: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    date: "2024-01-01",
    type: "buy",
    symbol: "VTI",
    quantity: 10,
    price: 100,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...patch,
  };
}

// 10 shares bought at $100 (cost basis $1,000), priced at $120 -> $1,200 market value.
const PRICES: PriceMap = { VTI: { price: 120, date: "2026-01-01" } };

function portfolioWith(pa: PortfolioAccount): Portfolio {
  return {
    id: "p1",
    accounts: [pa],
    transactions: [buy({ accountId: pa.id })],
    securities: [],
  };
}

describe("pendingForecastPushes", () => {
  it("pushes a linked account's current value and cost basis", () => {
    const pa = account({ id: "pa1", forecastAccountId: "fa1" });
    const fa = makeAccount({
      id: "fa1",
      class: "taxable_investment",
      taxTreatment: "taxable",
      startingBalance: 500,
      startingCostBasis: 200,
    });

    const pushes = pendingForecastPushes(portfolioWith(pa), PRICES, [fa]);

    expect(pushes).toEqual([
      { forecastAccountId: "fa1", startingBalance: 1200, startingCostBasis: 1000 },
    ]);
  });

  it("emits nothing once the forecast account already matches", () => {
    const pa = account({ id: "pa1", forecastAccountId: "fa1" });
    const fa = makeAccount({
      id: "fa1",
      class: "taxable_investment",
      taxTreatment: "taxable",
      startingBalance: 1200,
      startingCostBasis: 1000,
    });

    expect(pendingForecastPushes(portfolioWith(pa), PRICES, [fa])).toEqual([]);
  });

  it("emits nothing while a holding in the account is still unpriced", () => {
    const pa = account({ id: "pa1", forecastAccountId: "fa1" });
    const fa = makeAccount({
      id: "fa1",
      class: "taxable_investment",
      taxTreatment: "taxable",
      startingBalance: 500,
    });

    // No quote for VTI -- analyzePortfolio would fall back to cost basis, so
    // this must not push a guess into the plan.
    expect(pendingForecastPushes(portfolioWith(pa), {}, [fa])).toEqual([]);
  });

  it("emits nothing when syncToForecast is off", () => {
    const pa = account({ id: "pa1", forecastAccountId: "fa1", syncToForecast: false });
    const fa = makeAccount({
      id: "fa1",
      class: "taxable_investment",
      taxTreatment: "taxable",
      startingBalance: 500,
    });

    expect(pendingForecastPushes(portfolioWith(pa), PRICES, [fa])).toEqual([]);
  });

  it("emits nothing when the forecast link is dangling", () => {
    const pa = account({ id: "pa1", forecastAccountId: "does-not-exist" });

    expect(pendingForecastPushes(portfolioWith(pa), PRICES, [])).toEqual([]);
  });

  it("omits startingCostBasis for a non-taxable target", () => {
    const pa = account({ id: "pa1", forecastAccountId: "fa1" });
    const fa = makeAccount({
      id: "fa1",
      class: "tax_free",
      taxTreatment: "tax_free",
      startingBalance: 500,
    });

    expect(pendingForecastPushes(portfolioWith(pa), PRICES, [fa])).toEqual([
      { forecastAccountId: "fa1", startingBalance: 1200 },
    ]);
  });
});
