import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { analyzePortfolio, xirr } from "./metrics";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
    symbol: "VTI",
    quantity: 0,
    price: 0,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...partial,
  };
}

function portfolio(transactions: Transaction[], overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    id: "p1",
    accounts: [
      {
        id: "acct-1",
        name: "Brokerage",
        institution: "",
        type: "taxable",
        forecastAccountId: null,
        cashBalance: 0,
      },
    ],
    transactions,
    securities: [],
    ...overrides,
  };
}

describe("analyzePortfolio", () => {
  it("values a holding at the quoted price and reports unrealized gain", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      { VTI: { price: 150, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].marketValue).toBe(1500);
    expect(result.holdings[0].costBasis).toBe(1000);
    expect(result.holdings[0].unrealizedGain).toBe(500);
    expect(result.holdings[0].unrealizedGainPct).toBeCloseTo(0.5, 6);
    expect(result.summary.totalValue).toBe(1500);
  });

  it("weights positions against the total in scope", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "VXUS" }),
      ]),
      { VTI: { price: 300, date: "2026-08-03" }, VXUS: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    const vti = result.holdings.find((h) => h.symbol === "VTI");
    const vxus = result.holdings.find((h) => h.symbol === "VXUS");
    expect(vti?.weight).toBeCloseTo(0.75, 6);
    expect(vxus?.weight).toBeCloseTo(0.25, 6);
    expect(result.holdings.reduce((sum, h) => sum + h.weight, 0)).toBeCloseTo(1, 6);
  });

  it("splits realized gains into short and long term", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2023-01-10", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2026-01-10", quantity: 10, price: 100 }),
        tx({ type: "sell", date: "2026-06-10", quantity: 20, price: 150 }),
      ]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.summary.realizedLongTerm).toBeCloseTo(500, 6);
    expect(result.summary.realizedShortTerm).toBeCloseTo(500, 6);
    expect(result.summary.realizedGain).toBeCloseTo(1000, 6);
    expect(result.summary.realizedGainYtd).toBeCloseTo(1000, 6);
  });

  it("counts dividends as income without touching share count", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "dividend", date: "2024-04-10", amount: 42 }),
      ]),
      { VTI: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].quantity).toBe(10);
    expect(result.holdings[0].income).toBe(42);
    expect(result.summary.income).toBe(42);
  });

  it("falls back to cost basis when a symbol has no quote, keeping weights whole", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].price).toBeNull();
    expect(result.holdings[0].marketValue).toBe(1000);
    expect(result.holdings[0].unrealizedGain).toBe(0);
    expect(result.holdings[0].weight).toBeCloseTo(1, 6);
  });

  it("prefers a manual price over the quote feed", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })], {
        securities: [
          {
            symbol: "VTI",
            name: "Total Market",
            assetClass: "us_equity",
            manualPrice: 200,
            manualPriceDate: "2026-08-01",
          },
        ],
      }),
      { VTI: { price: 150, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].price).toBe(200);
    expect(result.holdings[0].marketValue).toBe(2000);
    expect(result.holdings[0].assetClass).toBe("us_equity");
  });

  it("narrows every figure to the accounts in scope", () => {
    const base = portfolio([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, accountId: "acct-2" }),
    ]);
    base.accounts.push({
      id: "acct-2",
      name: "IRA",
      institution: "",
      type: "roth_ira",
      forecastAccountId: null,
      cashBalance: 500,
    });

    const scoped = analyzePortfolio(base, { VTI: { price: 100, date: "2026-08-03" } }, {
      accountIds: ["acct-2"],
      asOf: "2026-08-04",
    });

    expect(scoped.holdings).toHaveLength(1);
    expect(scoped.summary.marketValue).toBe(1000);
    expect(scoped.summary.cash).toBe(500);
    expect(scoped.summary.totalValue).toBe(1500);
  });

  it("groups allocation by asset class", () => {
    const result = analyzePortfolio(
      portfolio(
        [
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "BND" }),
        ],
        {
          securities: [
            { symbol: "VTI", name: "", assetClass: "us_equity", manualPrice: null, manualPriceDate: null },
            { symbol: "BND", name: "", assetClass: "bond", manualPrice: null, manualPriceDate: null },
          ],
        },
      ),
      { VTI: { price: 300, date: "2026-08-03" }, BND: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.byAssetClass[0]).toMatchObject({ label: "us_equity", value: 3000 });
    expect(result.byAssetClass[1]).toMatchObject({ label: "bond", value: 1000 });
    expect(result.byAssetClass[0].weight).toBeCloseTo(0.75, 6);
  });
});

describe("xirr", () => {
  it("solves a clean doubling over one year", () => {
    const rate = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 2000 },
    ]);
    expect(rate).toBeCloseTo(1, 3);
  });

  it("counts the extra day in a leap year rather than assuming a flat 365", () => {
    const rate = xirr([
      { date: "2024-01-01", amount: -1000 },
      { date: "2025-01-01", amount: 2000 },
    ]);
    expect(rate).toBeCloseTo(2 ** (365 / 366) - 1, 4);
  });

  it("solves a flat return as zero", () => {
    const rate = xirr([
      { date: "2024-01-01", amount: -1000 },
      { date: "2025-01-01", amount: 1000 },
    ]);
    expect(rate).toBeCloseTo(0, 5);
  });

  it("returns null when the flows never change sign", () => {
    expect(
      xirr([
        { date: "2024-01-01", amount: -1000 },
        { date: "2025-01-01", amount: -500 },
      ]),
    ).toBeNull();
  });
});
