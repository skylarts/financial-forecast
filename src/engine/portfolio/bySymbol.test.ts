import { describe, expect, it } from "vitest";
import type { ClosedLot } from "./lots";
import type { Holding } from "./metrics";
import { gainForScope, inScope, returnForScope, rollUpBySymbol } from "./bySymbol";

function holding(patch: Partial<Holding> & { symbol: string }): Holding {
  return {
    key: `${patch.accountId ?? "acct-1"}::${patch.symbol}::long`,
    accountId: "acct-1",
    kind: "position",
    name: patch.symbol,
    assetClass: "us_equity",
    exposures: [],
    instrumentType: "other",
    themes: [],
    side: "long",
    quantity: 0,
    costBasis: 0,
    avgCostPerShare: 0,
    price: null,
    priceDate: null,
    marketValue: 0,
    unrealizedGain: 0,
    unrealizedGainPct: null,
    weight: 0,
    realizedGain: 0,
    income: 0,
    totalGain: 0,
    irr: null,
    lots: [],
    ...patch,
  };
}

function closedLot(patch: Partial<ClosedLot> & { symbol: string }): ClosedLot {
  return {
    id: "lot-1",
    accountId: "acct-1",
    side: "long",
    acquiredDate: "2024-01-01",
    disposedDate: "2024-07-01",
    quantity: 10,
    costBasis: 1000,
    proceeds: 1200,
    gain: 200,
    term: "short",
    taxable: true,
    unmatched: false,
    openTxId: "tx-open",
    closeTxId: "tx-close",
    ...patch,
  };
}

describe("rollUpBySymbol", () => {
  it("consolidates one symbol across accounts into a single row", () => {
    const rows = rollUpBySymbol(
      [
        holding({ symbol: "VTI", accountId: "acct-1", marketValue: 6000, costBasis: 4000, unrealizedGain: 2000, quantity: 20, weight: 0.3 }),
        holding({ symbol: "VTI", accountId: "acct-2", marketValue: 3000, costBasis: 2500, unrealizedGain: 500, quantity: 10, weight: 0.15 }),
      ],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "VTI",
      accountCount: 2,
      quantity: 30,
      marketValue: 9000,
      openCostBasis: 6500,
      unrealizedGain: 2500,
    });
    expect(rows[0].weight).toBeCloseTo(0.45, 6);
  });

  it("adds realized gains and dividends into the total the ranking uses", () => {
    const rows = rollUpBySymbol(
      [holding({ symbol: "AAPL", costBasis: 1000, marketValue: 1400, unrealizedGain: 400, income: 60 })],
      [closedLot({ symbol: "AAPL", costBasis: 500, gain: 150 })],
    );

    const aapl = rows[0];
    // 400 unrealized + 150 realized + 60 in dividends, over the $1,500 that was
    // ever actually committed to the name.
    expect(aapl.totalGain).toBe(610);
    expect(aapl.totalReturnPct).toBeCloseTo(610 / 1500, 6);
  });

  it("keeps a fully closed position in the table", () => {
    const rows = rollUpBySymbol([], [closedLot({ symbol: "PFE", gain: -300, costBasis: 1200 })]);

    expect(rows[0]).toMatchObject({
      symbol: "PFE",
      isOpen: false,
      marketValue: 0,
      realizedGain: -300,
      tradeCount: 1,
    });
    // No holding is left to name it, so the ticker stands in rather than blank.
    expect(rows[0].name).toBe("PFE");
  });

  it("ignores untaxed disposals so a transfer never counts as a losing trade", () => {
    const rows = rollUpBySymbol(
      [holding({ symbol: "BND" })],
      [
        closedLot({ symbol: "BND", gain: 100 }),
        closedLot({ symbol: "BND", gain: 0, taxable: false, untaxedReason: "transfer" }),
      ],
    );

    expect(rows[0].tradeCount).toBe(1);
    expect(rows[0].winRate).toBe(1);
    expect(rows[0].realizedGain).toBe(100);
  });

  it("reports win rate and the extremes across round trips", () => {
    const rows = rollUpBySymbol(
      [],
      [
        closedLot({ symbol: "NVDA", gain: 900 }),
        closedLot({ symbol: "NVDA", gain: -200 }),
        closedLot({ symbol: "NVDA", gain: 50 }),
      ],
    );

    expect(rows[0]).toMatchObject({ tradeCount: 3, winCount: 2, bestTrade: 900, worstTrade: -200 });
    expect(rows[0].winRate).toBeCloseTo(2 / 3, 6);
  });

  it("share-weights the average hold, so a big lot outweighs a token one", () => {
    const rows = rollUpBySymbol(
      [],
      [
        closedLot({ symbol: "MSFT", quantity: 90, acquiredDate: "2024-01-01", disposedDate: "2024-01-11" }),
        closedLot({ symbol: "MSFT", quantity: 10, acquiredDate: "2024-01-01", disposedDate: "2024-04-10" }),
      ],
    );

    // 90 shares held 10 days and 10 held 100 -- a plain mean would say 55.
    expect(rows[0].avgHoldDays).toBeCloseTo(19, 6);
  });

  it("leaves cash out entirely", () => {
    const rows = rollUpBySymbol(
      [
        holding({ symbol: "VTI", marketValue: 1000 }),
        { ...holding({ symbol: "$CASH", marketValue: 500 }), kind: "cash" },
      ],
      [],
    );

    expect(rows.map((r) => r.symbol)).toEqual(["VTI"]);
  });

  it("returns no percentage when nothing was ever committed", () => {
    const rows = rollUpBySymbol(
      [holding({ symbol: "GIFT", costBasis: 0, marketValue: 800, unrealizedGain: 800 })],
      [],
    );

    expect(rows[0].totalGain).toBe(800);
    expect(rows[0].totalReturnPct).toBeNull();
  });

  it("ranks by total gain, best first", () => {
    const rows = rollUpBySymbol(
      [
        holding({ symbol: "LOSER", unrealizedGain: -500, costBasis: 1000 }),
        holding({ symbol: "WINNER", unrealizedGain: 900, costBasis: 1000 }),
        holding({ symbol: "FLAT", unrealizedGain: 0, costBasis: 1000 }),
      ],
      [],
    );

    expect(rows.map((r) => r.symbol)).toEqual(["WINNER", "FLAT", "LOSER"]);
  });
});

describe("scope helpers", () => {
  const row = rollUpBySymbol(
    [holding({ symbol: "X", costBasis: 1000, unrealizedGain: 200, income: 50 })],
    [closedLot({ symbol: "X", costBasis: 500, gain: 100 })],
  )[0];

  it("measures each scope's gain against its own basis", () => {
    expect(gainForScope(row, "positions")).toBe(200);
    expect(returnForScope(row, "positions")).toBeCloseTo(0.2, 6);

    expect(gainForScope(row, "trades")).toBe(100);
    expect(returnForScope(row, "trades")).toBeCloseTo(0.2, 6);

    // Dividends belong to the whole story, not to either half of it.
    expect(gainForScope(row, "both")).toBe(350);
    expect(returnForScope(row, "both")).toBeCloseTo(350 / 1500, 6);
  });

  it("hides rows a scope has nothing to say about", () => {
    const closedOnly = rollUpBySymbol([], [closedLot({ symbol: "GONE" })])[0];
    const openOnly = rollUpBySymbol([holding({ symbol: "HELD" })], [])[0];

    expect(inScope(closedOnly, "positions")).toBe(false);
    expect(inScope(closedOnly, "trades")).toBe(true);
    expect(inScope(openOnly, "trades")).toBe(false);
    expect(inScope(openOnly, "positions")).toBe(true);
    expect(inScope(closedOnly, "both")).toBe(true);
  });
});
