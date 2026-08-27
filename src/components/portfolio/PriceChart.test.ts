import { describe, expect, it } from "vitest";
import { nearestTradeIndex } from "./PriceChart";

describe("nearestTradeIndex", () => {
  const trades = [10, 40, 41, 900];

  it("returns the hovered day itself when it holds a trade", () => {
    expect(nearestTradeIndex(trades, 40, 3)).toBe(40);
  });

  it("reaches a trade sitting just outside the hovered day", () => {
    expect(nearestTradeIndex(trades, 8, 3)).toBe(10);
    expect(nearestTradeIndex(trades, 903, 3)).toBe(900);
  });

  it("ignores trades beyond the radius", () => {
    expect(nearestTradeIndex(trades, 500, 3)).toBeNull();
  });

  it("picks the closer of two trades in range", () => {
    expect(nearestTradeIndex(trades, 43, 5)).toBe(41);
    expect(nearestTradeIndex(trades, 37, 5)).toBe(40);
  });

  it("handles a radius of zero and an empty ledger", () => {
    expect(nearestTradeIndex(trades, 39, 0)).toBeNull();
    expect(nearestTradeIndex(trades, 40, 0)).toBe(40);
    expect(nearestTradeIndex([], 40, 10)).toBeNull();
  });
});
