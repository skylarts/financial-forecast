import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import {
  annualizedReturn,
  buildPerformanceSeries,
  earliestCoveredDate,
  indexPrices,
  indexedReturn,
  symbolsForWindow,
  totalReturn,
  windowReturn,
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
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
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

  it("does not count a deposit as a gain, however large", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "cash_deposit", date: "2024-01-03", symbol: null, amount: 100000 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // The account is worth a hundred times what it was and earned 10%.
    expect(points[1].value).toBeCloseTo(101_100, 6);
    expect(totalReturn(points)).toBeCloseTo(0.1, 10);
  });

  it("counts cash left uninvested as the drag it is", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110], ["2024-01-04", 121]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "cash_deposit", date: "2024-01-03", symbol: null, amount: 100000 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-04" },
    );

    // VTI ran 10% again on the third day, but by then the deposit had left 99%
    // of the account sitting in cash, so the account barely moved. Measuring
    // the securities alone would have reported the full 10% a second time and
    // credited the account with a gain it never had.
    expect(totalReturn(points)).toBeCloseTo(0.1012, 4);
  });

  it("treats an account fee as a cost rather than money withdrawn", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 100]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 1000 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 5, price: 100 }),
        tx({ type: "fee", date: "2024-01-03", symbol: null, amount: 25 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // The money genuinely left. Excusing it would flatter every account that
    // pays to be run.
    expect(totalReturn(points)).toBeCloseTo(-0.025, 10);
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

  it("values a short as a liability against the cash it raised", () => {
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 90]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 1000 }),
        tx({ type: "short_sell", date: "2024-01-02", quantity: 10, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // The sale raised $1,000, so the account holds $2,000 in cash -- and owes
    // ten shares, which is why it is still only worth the $1,000 put in.
    expect(points[0].value).toBeCloseTo(1000, 6);
    // Covering got $100 cheaper, and on a $1,000 account that is a 10% gain.
    expect(points[1].value).toBeCloseTo(1100, 6);
    expect(totalReturn(points)).toBeCloseTo(0.1, 10);
  });

  it("survives selling out entirely and buying back weeks later", () => {
    // The failure this replaces: valuing securities alone, the account reads as
    // worth nothing while it sits in cash, and the repurchase then divides a
    // full position by whatever float dust the sale left behind. One such day
    // rescales every day after it, which is how a five-year figure ended up at
    // -98% against a market that rose.
    const histories = new Map([
      ["VTI", history([
        ["2024-01-02", 100], ["2024-01-03", 100], ["2024-01-04", 100],
        ["2024-01-05", 100], ["2024-01-08", 110],
      ])],
    ]);

    const { points, basis } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 1000 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "sell", date: "2024-01-03", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-05", quantity: 10, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-08" },
    );

    expect(basis).toBe("account");
    // Worth $1,000 throughout: in stock, then in cash, then in stock again.
    expect(points.slice(0, 4).map((p) => p.value)).toEqual([1000, 1000, 1000, 1000]);
    // Nothing happened until the last day, which is the only 10% in the window.
    expect(totalReturn(points)).toBeCloseTo(0.1, 10);
  });

  it("falls back to securities when the ledger cannot fund its own purchases", () => {
    // A part-imported ledger: years of trading with none of the deposits that
    // paid for it. Replaying cash would open the account at minus its own first
    // purchase, so the balance is not something this ledger can speak to.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
    ]);

    const { points, basis } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 })],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(basis).toBe("securities");
    expect(points[0].value).toBe(1000);
    expect(totalReturn(points)).toBeCloseTo(0.1, 6);
  });

  it("narrows to a symbol subset, ignoring the rest of the ledger entirely", () => {
    // A fully funded ledger -- basis would ordinarily be "account" -- but
    // filtered down to just VTI, BND's deposit-funded purchase shouldn't
    // count for or against it.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
      ["BND", history([["2024-01-02", 50], ["2024-01-03", 25]])],
    ]);

    const { points, basis } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 2000 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100, symbol: "VTI" }),
        // BND crashes 50% -- if it leaked into this series, the return
        // wouldn't be a clean 10%.
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 50, symbol: "BND" }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03", symbols: new Set(["VTI"]) },
    );

    // A slice has no cash balance of its own to fall back on.
    expect(basis).toBe("securities");
    expect(points[0].value).toBe(1000);
    expect(totalReturn(points)).toBeCloseTo(0.1, 6);
  });

  it("reads a purchase made before its deposit as money already in the account", () => {
    // Settlement routinely dates a buy a day ahead of the transfer that cleared
    // for it. The money was demonstrably there, so the account opens holding it
    // rather than at zero -- which would leave the next day nothing to measure.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
    ]);

    const { points, basis } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "cash_deposit", date: "2024-01-03", symbol: null, amount: 1000 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(basis).toBe("account");
    expect(points[0].value).toBeCloseTo(1000, 6);
    // The deposit settles the overdraft; only the 10% on the stock is return.
    expect(totalReturn(points)).toBeCloseTo(0.1, 10);
  });

  it("restates a reverse-split history into the units the ledger traded in", () => {
    // A leveraged fund after a run of reverse splits: the feed reports history
    // in terms of today's share, so a $8.28 holding reads as a small fortune
    // and buries every other position in the account.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 100], ["2024-01-03", 110]])],
      ["SOXS", history([["2024-01-02", 2_565_000], ["2024-01-03", 2_475_000]])],
    ]);

    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 1010 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 1, price: 8.28, symbol: "SOXS" }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    // Priced at the $8.28 it traded at -- and still tracking the feed's own
    // shape, which a flat fallback would have thrown away.
    expect(points[0].value).toBeCloseTo(1010, 2);
    expect(approximated).toEqual([]);
    const soxsNext = 8.28 * (2_475_000 / 2_565_000);
    expect(points[1].value).toBeCloseTo(1100 + soxsNext + 1.72, 2);
  });

  it("restates a forward-split history the same way", () => {
    // AMZN's twenty-for-one leaves adjusted history at a twentieth of what its
    // pre-split trades filled at, which understates the position just as badly
    // in the other direction.
    const histories = new Map([
      ["AMZN", history([["2024-01-02", 155], ["2024-01-03", 170.5]])],
    ]);

    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 3100 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 1, price: 3100, symbol: "AMZN" }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(approximated).toEqual([]);
    // One share bought at $3,100, up 10% with the feed.
    expect(points[0].value).toBeCloseTo(3100, 6);
    expect(points[1].value).toBeCloseTo(3410, 6);
    expect(totalReturn(points)).toBeCloseTo(0.1, 6);
  });

  it("keeps a history that merely differs by intraday movement", () => {
    // The guard must not fire on the ordinary gap between what a trade filled
    // at and where the day happened to close.
    const histories = new Map([
      ["VTI", history([["2024-01-02", 104], ["2024-01-03", 110]])],
    ]);

    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 1000 }),
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 100 }),
      ],
      histories,
      { from: "2024-01-02", to: "2024-01-03" },
    );

    expect(approximated).toEqual([]);
    expect(points[0].value).toBeCloseTo(1040, 6);
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

describe("a spinoff", () => {
  it("moves value into the new symbol and retires the parent on a full exchange", () => {
    const histories = new Map([["NEW", history([["2024-01-04", 5]])]]);

    const { points, approximated } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 10, symbol: "OLD" }),
        tx({
          type: "spinoff",
          date: "2024-01-03",
          symbol: "OLD",
          spinoffSymbol: "NEW",
          spinoffShareRatio: 2,
          spinoffBasisRetained: 0,
        }),
      ],
      histories,
      { from: "2024-01-04", to: "2024-01-04" },
    );

    // 10 OLD shares became 20 NEW shares; OLD holds nothing to value any more.
    expect(points[0].value).toBeCloseTo(100, 6);
    expect(approximated).not.toContain("OLD");
  });

  it("credits the new symbol without touching the parent's share count on a partial spinoff", () => {
    const histories = new Map([
      ["PARENT", history([["2024-01-04", 45]])],
      ["CHILD", history([["2024-01-04", 20]])],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", quantity: 10, price: 50, symbol: "PARENT" }),
        tx({
          type: "spinoff",
          date: "2024-01-03",
          symbol: "PARENT",
          spinoffSymbol: "CHILD",
          spinoffShareRatio: 0.5,
          spinoffBasisRetained: 0.8834,
        }),
      ],
      histories,
      { from: "2024-01-04", to: "2024-01-04" },
    );

    // 10 PARENT shares kept (real spinoff, basis moves but shares don't) plus
    // 5 new CHILD shares: 10 * $45 + 5 * $20.
    expect(points[0].value).toBeCloseTo(550, 6);
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

  it("narrows to a facet-filtered set of symbols", () => {
    const symbols = symbolsForWindow(
      [
        tx({ type: "buy", date: "2023-01-02", quantity: 10, price: 100, symbol: "VTI" }),
        tx({ type: "buy", date: "2023-01-02", quantity: 10, price: 100, symbol: "BND" }),
      ],
      "2024-01-01",
      "2024-12-31",
      undefined,
      new Set(["VTI"]),
    );

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

describe("the days between a split and the next trade", () => {
  /**
   * The real shape of Alphabet's twenty-for-one, which is where this was found.
   * The feed's closes are all in post-split shares; the ledger bought at $2,169
   * in June, took the split on 18 July, and did not trade again until the 22nd.
   *
   * Inferring the units from trades alone cannot learn the new factor until
   * that 22nd of July trade, so for four days the share count had multiplied by
   * twenty while the price was still being multiplied by twenty as well.
   */
  const googHistory = history([
    ["2022-06-16", 108.48], // $2,169.57 in the shares of the day
    ["2022-07-15", 113.0],
    ["2022-07-18", 111.0],
    ["2022-07-19", 112.0],
    ["2022-07-22", 108.36],
  ]);

  const bought = tx({
    type: "buy",
    date: "2022-06-16",
    symbol: "GOOG",
    quantity: 0.0046,
    price: 2169.5652,
  });
  const split = tx({ type: "split", date: "2022-07-18", symbol: "GOOG", quantity: 20 });
  const boughtAgain = tx({
    type: "buy",
    date: "2022-07-22",
    symbol: "GOOG",
    quantity: 0.0922,
    price: 108.4599,
  });

  const histories = new Map([["GOOG", googHistory]]);
  const window = { from: "2022-06-16", to: "2022-07-22" } as const;

  it("carries a split holding at a steady value when the feed's calendar is known", () => {
    const { points } = buildPerformanceSeries(
      [bought, split, boughtAgain],
      histories,
      { ...window, splits: new Map([["GOOG", [{ date: "2022-07-18", ratio: 20 }]]]) },
    );

    // 0.0046 shares becomes 0.092 across the split, and $111 x 0.092 is $10.21.
    // Without the calendar this day is worth twenty times that.
    const onSplitDay = points.find((p) => p.date === "2022-07-18");
    expect(onSplitDay?.value).toBeCloseTo(0.092 * 111.0, 4);

    // Nothing in the window may move more than the price did.
    const values = points.map((p) => p.value);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(11);
  });

  it("falls back to inference for a ledger that never posted the split", () => {
    // No split row, so the share count never multiplied and the position is
    // still counted in pre-split shares. Scaling its prices by the calendar
    // would compound the mismatch rather than resolve it.
    const { points } = buildPerformanceSeries(
      [bought],
      histories,
      { ...window, splits: new Map([["GOOG", [{ date: "2022-07-18", ratio: 20 }]]]) },
    );

    // 0.0046 pre-split shares at ~$2,220, not at $111.
    const onSplitDay = points.find((p) => p.date === "2022-07-18");
    expect(onSplitDay?.value).toBeCloseTo(0.0046 * 111.0 * 20, 2);
  });

  it("prices the years before a split in the shares the ledger held then", () => {
    const { points } = buildPerformanceSeries(
      [bought, split, boughtAgain],
      histories,
      { ...window, splits: new Map([["GOOG", [{ date: "2022-07-18", ratio: 20 }]]]) },
    );

    // The purchase day itself: 0.0046 shares at $2,169.57, not at $108.48.
    expect(points[0].value).toBeCloseTo(0.0046 * 108.48 * 20, 4);
  });

  it("matches a broker that posted the split a day or two late", () => {
    const lateSplit = tx({
      type: "split",
      date: "2022-07-19",
      symbol: "GOOG",
      quantity: 20,
    });

    const { points } = buildPerformanceSeries(
      [bought, lateSplit, boughtAgain],
      histories,
      { ...window, splits: new Map([["GOOG", [{ date: "2022-07-18", ratio: 20 }]]]) },
    );

    // The price flips to post-split shares on the 19th, the same day the share
    // count does -- not on the 18th, which would leave the 18th counted in old
    // shares and priced in new ones.
    expect(points.find((p) => p.date === "2022-07-18")?.value).toBeCloseTo(
      0.0046 * 111.0 * 20,
      2,
    );
    expect(points.find((p) => p.date === "2022-07-19")?.value).toBeCloseTo(
      0.092 * 112.0,
      4,
    );

    const values = points.map((p) => p.value);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(11);
  });

  it("restates a reverse split in the other direction", () => {
    // One-for-ten: the feed's old closes are a tenth of what was really paid.
    const reverseHistory = history([
      ["2024-01-02", 50],
      ["2024-01-03", 48],
      ["2024-01-04", 47],
    ]);

    const { points } = buildPerformanceSeries(
      [
        tx({ type: "buy", date: "2024-01-02", symbol: "SOXS", quantity: 100, price: 5 }),
        tx({ type: "split", date: "2024-01-04", symbol: "SOXS", quantity: 0.1 }),
      ],
      new Map([["SOXS", reverseHistory]]),
      {
        from: "2024-01-02",
        to: "2024-01-04",
        splits: new Map([["SOXS", [{ date: "2024-01-04", ratio: 0.1 }]]]),
      },
    );

    // 100 shares at $5 on the way in, 10 shares at $47 on the way out.
    expect(points[0].value).toBeCloseTo(500, 6);
    expect(points[points.length - 1].value).toBeCloseTo(470, 6);
  });
});

describe("windowReturn", () => {
  /** Four years of a steady 10% a year, so every window has a known answer. */
  const built = () => {
    const histories = new Map([
      [
        "VTI",
        history([
          ["2023-01-03", 100],
          ["2024-01-03", 110],
          ["2025-01-03", 121],
          ["2026-01-03", 133.1],
          ["2026-08-03", 133.1],
        ]),
      ],
    ]);
    const { points } = buildPerformanceSeries(
      [tx({ type: "buy", date: "2023-01-03", quantity: 10, price: 100 })],
      histories,
      { from: "2023-01-03", to: "2026-08-03" },
    );
    return { points, histories };
  };

  it("reads a narrower window off a series built once", () => {
    const { points, histories } = built();
    const start = earliestCoveredDate(histories);

    // Read off the same chained index a purpose-built series would have
    // produced for 2024 alone.
    expect(windowReturn(points, "2024-01-03", "2025-01-03", start).total).toBeCloseTo(0.1, 6);
    expect(windowReturn(points, "2023-01-03", "2026-01-03", start).total).toBeCloseTo(0.331, 6);
  });

  it("annualizes a multi-year window and leaves a short one alone", () => {
    const { points, histories } = built();
    const start = earliestCoveredDate(histories);

    // Not exact to the last digit: the span is measured in 365-day years, and
    // the window spans a leap day.
    expect(windowReturn(points, "2023-01-03", "2026-01-03", start).annualized).toBeCloseTo(0.1, 3);
    // Under a year, the plain return -- projecting it would invent a forecast.
    const partial = windowReturn(points, "2026-01-03", "2026-08-03", start);
    expect(partial.annualized).toBe(partial.total);
  });

  it("refuses a window that opens before the loaded history does", () => {
    const { points, histories } = built();
    const start = earliestCoveredDate(histories);

    // Answering here would report a 3.5-year return under a 10-year label.
    expect(windowReturn(points, "2016-01-03", "2026-08-03", start).total).toBeNull();
  });

  it("refuses every window when nothing was loaded at all", () => {
    const { points } = built();
    expect(windowReturn(points, "2024-01-03", "2025-01-03", null).total).toBeNull();
  });
});

describe("earliestCoveredDate", () => {
  it("takes the oldest date any symbol reaches back to", () => {
    const histories = new Map([
      ["VTI", history([["2020-01-02", 100]])],
      ["VXUS", history([["2018-01-02", 50]])],
    ]);

    expect(earliestCoveredDate(histories)).toBe("2018-01-02");
  });

  it("has no answer for an empty set of histories", () => {
    expect(earliestCoveredDate(new Map())).toBeNull();
  });
});
