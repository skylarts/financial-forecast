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

  it("stays quiet about an unpriced contract the ledger already closed", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 100]])],
    ]);

    const symbol = "KLAR260508C00015000";
    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 1, price: 2, symbol }),
        tx({ type: "option_expire", date: "2024-01-04", quantity: 1, symbol }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    // The feed had nothing for the contract, so it leaned on the fallback all
    // the same -- but expiry retired it at zero, which is a fact and not a
    // guess, so there is nothing left to warn about.
    expect(points[0].value).toBe(1000 + 200);
    expect(points[2].value).toBe(1000);
    expect(approximated).toEqual([]);
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

describe("symbol priority against a capped request", () => {
  // The caller's order is a priority order: whatever it lists first is what
  // survives the server's cap. Sorting the whole list alphabetically is what
  // let a wide ledger drop every holding past the cut-off.
  it("puts still-open positions ahead of closed ones", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2024-02-01", quantity: 10, price: 100, symbol: "AAA" }),
        tx({ type: "sell", date: "2024-03-01", quantity: 10, price: 120, symbol: "AAA" }),
        tx({ type: "buy", date: "2024-02-01", quantity: 5, price: 100, symbol: "ZZZ" }),
      ],
      "2024-01-01",
      "2024-12-31",
    );

    // ZZZ is still held, so it leads despite sorting last.
    expect(symbols).toEqual(["ZZZ", "AAA"]);
  });

  it("still returns every symbol the window needs", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2024-02-01", quantity: 1, price: 10, symbol: "CCC" }),
        tx({ type: "sell", date: "2024-05-01", quantity: 1, price: 12, symbol: "CCC" }),
        tx({ type: "buy", date: "2024-02-01", quantity: 1, price: 10, symbol: "BBB" }),
        tx({ type: "buy", date: "2024-02-01", quantity: 1, price: 10, symbol: "DDD" }),
      ],
      "2024-01-01",
      "2024-12-31",
    );

    expect([...symbols].sort()).toEqual(["BBB", "CCC", "DDD"]);
    expect(symbols.slice(0, 2).sort()).toEqual(["BBB", "DDD"]);
  });
});

describe("a day the feed could not price", () => {
  // An unpriced holding is carried at the last figure paid, so a big purchase
  // can exceed everything the book appears to be worth. That factor is a
  // valuation failure, not a return, and letting it through flips the index
  // negative and compounds the wrong way for every day after it.
  // The fallback is the last figure ever paid, applied to every day in the
  // window -- so a holding bought high and topped up cheap later is carried at
  // the cheap price on the day of the expensive purchase. The money spent then
  // dwarfs what the book appears to be worth, and the factor turns negative.
  it("holds the index flat rather than letting it go negative", () => {
    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 1, price: 100, symbol: "PRICED" }),
        // Nothing in `histories` for this one, so both days lean on the
        // fallback, which ends up being the $1 paid on the second day.
        tx({ type: "buy", date: "2024-01-03", quantity: 10, price: 100, symbol: "DARK" }),
        tx({ type: "buy", date: "2024-01-04", quantity: 1, price: 1, symbol: "DARK" }),
      ],
      new Map([["PRICED", history([["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 110]])]]),
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(points.every((p) => p.index > 0)).toBe(true);
    expect(totalReturn(points)).not.toBeNull();
    expect(totalReturn(points)!).toBeGreaterThan(-1);
  });
});

describe("valuing a day the feed has no close for", () => {
  // The close is found by binary search over years of daily points, so the
  // cases that matter are the edges: a day before the first close, a day
  // between two, and a day past the last.
  it("carries the last close forward across gaps and past the end", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-05", 120]])],
      // Priced only on the days in between, to put dates in the window that
      // VTI itself has no point for.
      ["SPY", history([["2024-01-02", 10], ["2024-01-03", 10], ["2024-01-04", 10], ["2024-01-05", 10], ["2024-01-08", 10]])],
    ]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-02", to: "2024-01-08" },
    );

    expect(points.map((p) => `${p.date}:${p.value}`)).toEqual([
      "2024-01-02:1000",
      // No close on the 3rd or 4th: the 2nd's price still stands.
      "2024-01-03:1000",
      "2024-01-04:1000",
      "2024-01-05:1200",
      // Past VTI's last point, still carried rather than dropping to zero.
      "2024-01-08:1200",
    ]);
  });

  it("holds a position opened before the feed's first close at nothing", () => {
    const histories = new Map([["VTI", history([["2024-01-05", 100]])]]);

    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-05", to: "2024-01-05" },
    );

    expect(points[0].value).toBe(1000);
  });
});

describe("a day whose flow dwarfs what was invested", () => {
  // This series values securities alone, so selling out entirely reads as an
  // empty book even though the cash is sitting there waiting. Buying back in
  // then divides a whole position by the float dust the sale left behind --
  // not a loss of everything, just a denominator that was never a base.
  it("does not read buying back into an emptied portfolio as a total loss", () => {
    const histories = new Map([
      [
        "VTI",
        history([
          ["2024-01-02", 100],
          ["2024-01-03", 100],
          ["2024-01-04", 99.5],
        ]),
      ],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        // Sold down to a sliver -- not to nothing, which the empty-book check
        // already covers. What is left is the base the next day divides by.
        tx({ type: "sell", date: "2024-01-03", quantity: 9, price: 100 }),
        // The same money straight back to work: $10,000 of flow against the
        // $100 still on the books. Measured, that reads as losing half the
        // portfolio on a day the shares moved half a percent.
        tx({ type: "buy", date: "2024-01-04", quantity: 100, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    expect(totalReturn(points)).toBeCloseTo(0, 6);
  });

  it("still measures an ordinary day that adds to an existing position", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        // $220 against a $1,000 base is a normal top-up, not a restart. Bought
        // at the day's close, so it carries no same-day gain of its own and
        // what is left to measure is the 10% the original shares made.
        tx({ type: "buy", date: "2024-01-03", quantity: 2, price: 110 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(totalReturn(points)).toBeCloseTo(0.1, 6);
  });
});
