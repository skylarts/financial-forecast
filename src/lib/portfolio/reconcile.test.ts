import { describe, expect, it } from "vitest";
import type { Holding } from "@/engine/portfolio/metrics";
import { parseHoldingsStatement, reconcileHoldings } from "./reconcile";

function holding(partial: Partial<Holding> & { symbol: string; quantity: number }): Holding {
  return {
    key: `${partial.symbol}-key`,
    accountId: "acct-1",
    name: partial.symbol,
    assetClass: "other",
    side: "long",
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
    ...partial,
  };
}

describe("parseHoldingsStatement", () => {
  it("reads a CSV export with headers", () => {
    const positions = parseHoldingsStatement(
      ["Symbol,Quantity,Total Cost", "VTI,30,5981.25", "AAPL,25,3768.75"].join("\n"),
    );

    expect(positions).toEqual([
      { symbol: "VTI", quantity: 30, side: "long", costBasis: 5981.25 },
      { symbol: "AAPL", quantity: 25, side: "long", costBasis: 3768.75 },
    ]);
  });

  it("reads a bare symbol-and-quantity list with no header", () => {
    const positions = parseHoldingsStatement(["VTI 30", "AAPL 25"].join("\n"));

    expect(positions.map((p) => [p.symbol, p.quantity])).toEqual([
      ["VTI", 30],
      ["AAPL", 25],
    ]);
  });

  it("reads a negative quantity as a short position", () => {
    const positions = parseHoldingsStatement(["Symbol,Quantity", "GME,-100"].join("\n"));

    expect(positions[0]).toMatchObject({ symbol: "GME", quantity: 100, side: "short" });
  });

  it("skips rows with no usable quantity", () => {
    const positions = parseHoldingsStatement(
      ["Symbol,Quantity", "VTI,30", "Cash,--", "TOTAL,"].join("\n"),
    );

    expect(positions.map((p) => p.symbol)).toEqual(["VTI"]);
  });
});

describe("reconcileHoldings", () => {
  it("reports a clean match", () => {
    const result = reconcileHoldings(
      [{ symbol: "VTI", quantity: 30, side: "long", costBasis: null }],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    expect(result.discrepancies).toBe(0);
    expect(result.rows[0].status).toBe("match");
  });

  it("flags missing purchases when the statement holds more", () => {
    const result = reconcileHoldings(
      [{ symbol: "VTI", quantity: 50, side: "long", costBasis: null }],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    expect(result.rows[0].status).toBe("missing_buys");
    expect(result.rows[0].difference).toBe(20);
    expect(result.rows[0].advice).toContain("purchase is missing");
  });

  it("flags missing sales when the ledger holds more", () => {
    const result = reconcileHoldings(
      [{ symbol: "VTI", quantity: 10, side: "long", costBasis: null }],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    expect(result.rows[0].status).toBe("missing_sells");
    expect(result.rows[0].difference).toBe(-20);
  });

  it("flags a position with no transaction history at all", () => {
    const result = reconcileHoldings(
      [{ symbol: "MSFT", quantity: 40, side: "long", costBasis: null }],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    const msft = result.rows.find((r) => r.symbol === "MSFT");
    expect(msft?.status).toBe("unknown_position");
    expect(msft?.advice).toContain("whole purchase history is missing");
  });

  it("flags a ledger position the statement never mentions", () => {
    const result = reconcileHoldings(
      [],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    expect(result.rows[0].status).toBe("not_held");
    expect(result.rows[0].advice).toContain("closing sale is missing");
  });

  it("keeps long and short positions in the same symbol apart", () => {
    const result = reconcileHoldings(
      [
        { symbol: "GME", quantity: 100, side: "short", costBasis: null },
        { symbol: "GME", quantity: 10, side: "long", costBasis: null },
      ],
      [
        holding({ symbol: "GME", quantity: 100, side: "short", key: "s" }),
        holding({ symbol: "GME", quantity: 10, side: "long", key: "l" }),
      ],
      "acct-1",
    );

    expect(result.discrepancies).toBe(0);
    expect(result.rows).toHaveLength(2);
  });

  it("ignores holdings belonging to other accounts", () => {
    const result = reconcileHoldings(
      [{ symbol: "VTI", quantity: 30, side: "long", costBasis: null }],
      [
        holding({ symbol: "VTI", quantity: 30 }),
        holding({ symbol: "VXUS", quantity: 99, accountId: "acct-2", key: "other" }),
      ],
      "acct-1",
    );

    expect(result.rows).toHaveLength(1);
    expect(result.discrepancies).toBe(0);
  });

  it("sorts discrepancies ahead of matches", () => {
    const result = reconcileHoldings(
      [
        { symbol: "VTI", quantity: 30, side: "long", costBasis: null },
        { symbol: "AAPL", quantity: 90, side: "long", costBasis: null },
      ],
      [holding({ symbol: "VTI", quantity: 30 }), holding({ symbol: "AAPL", quantity: 25, key: "a" })],
      "acct-1",
    );

    expect(result.rows[0].symbol).toBe("AAPL");
    expect(result.rows[0].status).toBe("missing_buys");
    expect(result.rows[1].status).toBe("match");
  });

  it("absorbs fractional dust rather than reporting it as a gap", () => {
    const result = reconcileHoldings(
      [{ symbol: "VTI", quantity: 30.00001, side: "long", costBasis: null }],
      [holding({ symbol: "VTI", quantity: 30 })],
      "acct-1",
    );

    expect(result.rows[0].status).toBe("match");
  });
});
