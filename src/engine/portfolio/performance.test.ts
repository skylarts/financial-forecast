import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import {
  annualizedReturn,
  buildPerformanceSeries,
  indexPrices,
  indexedReturn,
  symbolsForWindow,
  totalReturn,
  type PricePoint,
} from "./performance";

let seq = 0;
function tx(patch: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
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
    ...patch,
  };
}

/** Daily closes from a list of [date, close] pairs. */
function history(pairs: [string, number][]): PricePoint[] {
  return pairs.map(([date, close]) => ({ date, close }));
}

describe("buildPerformanceSeries", () => {
  it("tracks a buy-and-hold position as the price moves", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110], ["2024-01-04", 121]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(points.map((p) => p.value)).toEqual([1000, 1100, 1210]);
    // Two 10% days compound to 21%, and the opening purchase is not a gain.
    expect(totalReturn(points)).toBeCloseTo(0.21, 6);
  });

  it("does not count a contribution as performance", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 100]])],
    ]);

    // Doubling the position at a flat price: the account is worth twice as
    // much and has returned exactly nothing.
    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-03", quantity: 10, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(points.map((p) => p.value)).toEqual([1000, 2000, 2000]);
    expect(totalReturn(points)).toBeCloseTo(0, 10);
  });

  it("does not count a withdrawal as a loss", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 100]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "sell", date: "2024-01-03", quantity: 5, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(points.map((p) => p.value)).toEqual([1000, 500, 500]);
    expect(totalReturn(points)).toBeCloseTo(0, 10);
  });

  it("counts a cash dividend as return, not as a withdrawal", () => {
    // The share price drops by the dividend, so without crediting the payment
    // the day reads as a 5% loss. It was a wash.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 95]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "dividend", date: "2024-01-03", amount: 50 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(totalReturn(points)).toBeCloseTo(0, 10);
  });

  it("ignores deposits and account fees, which never touch the investments", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "cash_deposit", date: "2024-01-03", symbol: null, amount: 100000 }),
        tx({ type: "fee", date: "2024-01-03", symbol: null, amount: 25 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // A six-figure deposit sitting in cash must not dilute a 10% day.
    expect(totalReturn(points)).toBeCloseTo(0.1, 10);
  });

  it("treats transferred-in shares as arriving value, not as a windfall", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 100]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "transfer_in", date: "2024-01-03", quantity: 10, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(points[1].value).toBe(2000);
    // Shares moving in from another brokerage are not a 100% gain.
    expect(totalReturn(points)).toBeCloseTo(0, 10);
  });

  it("starts the window from positions already held", () => {
    const histories = new Map([
      ["VTI", history([["2024-06-03", 200], ["2024-06-04", 220]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2020-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-06-03", to: "2024-06-04" },
    );

    // The purchase predates the window, so it is a starting balance, not a flow.
    expect(points[0].value).toBe(2000);
    expect(points[0].flow).toBe(0);
    expect(totalReturn(points)).toBeCloseTo(0.1, 6);
  });

  it("applies a split to the share count without booking a return", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 50]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "split", date: "2024-01-03", quantity: 2 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // Twice the shares at half the price is the same money.
    expect(points[1].value).toBe(1000);
    expect(totalReturn(points)).toBeCloseTo(0, 10);
  });

  it("holds an unpriced symbol flat and says which ones it did that to", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100]])],
    ]);

    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 5, price: 40, symbol: "DELISTED" }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // Carried at its last traded price rather than dropping to zero, which
    // would have shown as a loss that never happened.
    expect(points[0].value).toBe(1000 + 200);
    expect(approximated).toEqual(["DELISTED"]);
  });

  it("values a short as a liability", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 90]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "short_sell", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(points[0].value).toBe(-1000);
    expect(points[1].value).toBe(-900);
  });

  it("returns nothing when no history covers the window", () => {
    const { points, approximated } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      new Map(),
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(points).toEqual([]);
    expect(approximated).toEqual([]);
  });

  it("scopes to the accounts asked for", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 90, price: 100, accountId: "acct-2" }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03", accountIds: ["acct-1"] },
    );

    expect(points[0].value).toBe(1000);
  });
});

describe("annualizedReturn", () => {
  it("compounds a multi-year window down to a yearly rate", () => {
    const histories = new Map([
      ["VTI", history([["2022-01-03", 100], ["2024-01-03", 121]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2022-01-03", quantity: 10, price: 100 })],
      histories,
      { from: "2022-01-03", to: "2024-01-03" },
    );

    expect(totalReturn(points)).toBeCloseTo(0.21, 6);
    // 21% over two years is a shade under 10% a year.
    expect(annualizedReturn(points)).toBeCloseTo(0.0999, 3);
  });

  it("reports a short window as it stands rather than projecting it", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-02-02", 110]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-02", to: "2024-02-02" },
    );

    // A 10% month is not a 214% year, and saying so would invent a forecast.
    expect(annualizedReturn(points)).toBeCloseTo(0.1, 6);
  });
});

describe("symbolsForWindow", () => {
  it("keeps a position still held going into the window", () => {
    const symbols = symbolsForWindow(
      [tx({ type: "buy", date: "2020-01-02", quantity: 10, price: 100 })],
      "2024-01-01",
      "2024-12-31",
    );

    expect(symbols).toEqual(["VTI"]);
  });

  it("drops a position closed before the window opens", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2020-01-02", quantity: 10, price: 100, symbol: "GONE" }),
        tx({ type: "sell", date: "2021-01-02", quantity: 10, price: 120, symbol: "GONE" }),
        tx({ type: "buy", date: "2020-01-02", quantity: 5, price: 100 }),
      ],
      "2024-01-01",
      "2024-12-31",
    );

    // Sold out three years before the window -- it has no bearing on it, and
    // asking the feed about it is a request that can only crowd out a live one.
    expect(symbols).toEqual(["VTI"]);
  });

  it("keeps something traded inside the window even if it ends flat", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2024-03-01", quantity: 10, price: 100, symbol: "SWING" }),
        tx({ type: "sell", date: "2024-04-01", quantity: 10, price: 120, symbol: "SWING" }),
      ],
      "2024-01-01",
      "2024-12-31",
    );

    expect(symbols).toEqual(["SWING"]);
  });

  it("ignores anything first bought after the window closes", () => {
    const symbols = symbolsForWindow(
      [tx({ type: "buy", date: "2025-06-01", quantity: 10, price: 100, symbol: "LATER" })],
      "2024-01-01",
      "2024-12-31",
    );

    expect(symbols).toEqual([]);
  });

  it("narrows to the accounts asked for", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2023-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2023-01-02", quantity: 10, price: 100, symbol: "OTHER", accountId: "acct-2" }),
      ],
      "2024-01-01",
      "2024-12-31",
      ["acct-1"],
    );

    expect(symbols).toEqual(["VTI"]);
  });

  it("leaves out an option contract that expired before the window", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2022-01-03", quantity: 1, price: 4, symbol: "AAPL220121C00150000" }),
        tx({ type: "option_expire", date: "2022-01-21", quantity: 1, symbol: "AAPL220121C00150000" }),
        tx({ type: "buy", date: "2022-01-03", quantity: 10, price: 100 }),
      ],
      "2024-01-01",
      "2024-12-31",
    );

    // The contract is gone and the feed will never answer for it again.
    expect(symbols).toEqual(["VTI"]);
  });
});

describe("indexPrices", () => {
  it("rebases a benchmark to the window so it shares an axis", () => {
    const indexed = indexPrices(
      history([["2023-12-01", 50], ["2024-01-02", 400], ["2024-01-03", 440]]),
      "2024-01-02",
      "2024-01-03",
    );

    expect(indexed).toHaveLength(2);
    expect(indexed[0].index).toBe(1);
    expect(indexed[1].index).toBeCloseTo(1.1, 6);
    expect(indexedReturn(indexed)).toBeCloseTo(0.1, 6);
  });

  it("gives nothing back when the window has no prices in it", () => {
    expect(indexPrices(history([["2020-01-02", 50]]), "2024-01-02", "2024-01-03")).toEqual([]);
  });
});
