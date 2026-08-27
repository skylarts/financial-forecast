import { describe, expect, it } from "vitest";
import type { Holding } from "@/engine/portfolio/metrics";
import type { Exposure } from "@/domain/portfolio";
import { groupsFor, rowsFor } from "./HoldingsTable";

function holding(
  symbol: string,
  marketValue: number,
  exposures: Exposure[],
  themes: string[] = [],
): Holding {
  return {
    key: symbol,
    accountId: "acct",
    kind: "position",
    symbol,
    name: symbol,
    assetClass: exposures[0]?.assetClass ?? "other",
    exposures,
    instrumentType: "etf",
    themes,
    side: "long",
    quantity: 1,
    costBasis: marketValue,
    avgCostPerShare: marketValue,
    price: marketValue,
    priceDate: "2026-01-01",
    marketValue,
    unrealizedGain: 0,
    unrealizedGainPct: 0,
    dayChange: null,
    dayChangePct: null,
    weight: 0,
    realizedGain: 0,
    income: 0,
    totalGain: 0,
    irr: null,
    lots: [],
  };
}

/** Sorts by market value the way the table's own value column does. */
function byValue(rows: ReturnType<typeof rowsFor>, direction: "asc" | "desc") {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => (a.marketValue - b.marketValue) * factor);
}

const NAMES = new Map([["acct", "Brokerage"]]);

/**
 * A fund whose money is overwhelmingly international, held alongside a smaller
 * pure-US position. The whole fund outweighs it; the fund's US *slice* does not.
 */
const SPLIT_FUND = holding("MIX", 20_000, [
  { assetClass: "us_equity", weight: 0.1 },
  { assetClass: "intl_equity", weight: 0.9 },
]);
const US_FUND = holding("USA", 10_000, [{ assetClass: "us_equity", weight: 1 }]);

describe("grouping holdings by asset class", () => {
  it("splits a multi-class holding's value across its classes", () => {
    const rows = rowsFor([SPLIT_FUND], "assetClass");
    expect(rows.map((r) => [r.groupLabel, r.marketValue])).toEqual([
      ["US Equity", 2_000],
      ["International Equity", 18_000],
    ]);
  });

  it("orders groups by their own subtotal, not by the top row's whole position", () => {
    const rows = byValue(rowsFor([SPLIT_FUND, US_FUND], "assetClass"), "desc");
    const groups = groupsFor(rows, "assetClass", NAMES, { key: "value", direction: "desc" });
    // International holds $18,000 against US Equity's $12,000, even though the
    // single largest position is 90% international and only 10% US.
    expect(groups.map((g) => g.label)).toEqual(["International Equity", "US Equity"]);
  });

  it("orders positions inside a group by their slice, not their whole position", () => {
    const rows = byValue(rowsFor([SPLIT_FUND, US_FUND], "assetClass"), "desc");
    const groups = groupsFor(rows, "assetClass", NAMES, { key: "value", direction: "desc" });
    const us = groups.find((g) => g.label === "US Equity");
    expect(us?.rows.map((r) => [r.symbol, r.marketValue])).toEqual([
      ["USA", 10_000],
      ["MIX", 2_000],
    ]);
  });

  it("puts the smallest group first when the sort is ascending", () => {
    const rows = byValue(rowsFor([SPLIT_FUND, US_FUND], "assetClass"), "asc");
    const groups = groupsFor(rows, "assetClass", NAMES, { key: "value", direction: "asc" });
    expect(groups.map((g) => g.label)).toEqual(["US Equity", "International Equity"]);
  });

  it("leaves groups in first-row order for a column that doesn't add up", () => {
    const rows = byValue(rowsFor([SPLIT_FUND, US_FUND], "assetClass"), "desc");
    const groups = groupsFor(rows, "assetClass", NAMES, { key: "return", direction: "desc" });
    expect(groups.map((g) => g.label)).toEqual(["International Equity", "US Equity"]);
  });
});

describe("grouping holdings by theme", () => {
  it("shows a doubly-tagged holding at full value under each tag", () => {
    const tagged = holding("BOTH", 5_000, [{ assetClass: "us_equity", weight: 1 }], ["Core", "AI"]);
    const rows = rowsFor([tagged], "theme");
    expect(rows.map((r) => [r.groupLabel, r.marketValue])).toEqual([
      ["Core", 5_000],
      ["AI", 5_000],
    ]);
    // Distinct keys, or React would see the two rows as one.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("orders theme groups by their subtotal", () => {
    const big = holding("BIG", 9_000, [{ assetClass: "us_equity", weight: 1 }], ["AI"]);
    const small = holding("SM1", 6_000, [{ assetClass: "us_equity", weight: 1 }], ["Core"]);
    const small2 = holding("SM2", 5_000, [{ assetClass: "us_equity", weight: 1 }], ["Core"]);
    const rows = byValue(rowsFor([big, small, small2], "theme"), "desc");
    const groups = groupsFor(rows, "theme", NAMES, { key: "value", direction: "desc" });
    expect(groups.map((g) => g.label)).toEqual(["Core", "AI"]);
  });
});
