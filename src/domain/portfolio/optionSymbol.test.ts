import { describe, expect, it } from "vitest";
import {
  contractMultiplier,
  formatOptionSymbol,
  isExpiredOption,
  isOptionSymbol,
  parseOptionSymbol,
} from "./optionSymbol";

describe("parseOptionSymbol", () => {
  it("reads a standard OCC contract", () => {
    expect(parseOptionSymbol("AAPL260918C00250000")).toEqual({
      underlying: "AAPL",
      expiry: "2026-09-18",
      right: "call",
      strike: 250,
    });
  });

  it("reads a put", () => {
    expect(parseOptionSymbol("SPY270115P00600000")?.right).toBe("put");
  });

  it("reads a fractional strike", () => {
    expect(parseOptionSymbol("F260918C00012500")?.strike).toBe(12.5);
  });

  it("accepts the space-padded form some brokerages emit", () => {
    expect(parseOptionSymbol("AAPL 260918C00250000")?.underlying).toBe("AAPL");
  });

  it("is case insensitive", () => {
    expect(parseOptionSymbol("aapl260918c00250000")?.strike).toBe(250);
  });

  it("returns null for ordinary tickers", () => {
    for (const symbol of ["VTI", "BRK-B", "AAPL", "^GSPC"]) {
      expect(parseOptionSymbol(symbol)).toBeNull();
    }
  });

  it("rejects an impossible calendar date", () => {
    expect(parseOptionSymbol("AAPL261318C00250000")).toBeNull();
    expect(parseOptionSymbol("AAPL260032C00250000")).toBeNull();
  });

  it("rejects a zero strike", () => {
    expect(parseOptionSymbol("AAPL260918C00000000")).toBeNull();
  });
});

describe("contractMultiplier", () => {
  it("is 100 for a contract and 1 for a share", () => {
    expect(contractMultiplier("AAPL260918C00250000")).toBe(100);
    expect(contractMultiplier("VTI")).toBe(1);
  });
});

describe("formatOptionSymbol", () => {
  it("renders a contract the way a statement reads", () => {
    expect(formatOptionSymbol("AAPL260918C00250000")).toBe("AAPL Sep 18 2026 250 Call");
  });

  it("keeps decimals only when the strike has them", () => {
    expect(formatOptionSymbol("F260918C00012500")).toBe("F Sep 18 2026 12.50 Call");
  });

  it("passes ordinary tickers through untouched", () => {
    expect(formatOptionSymbol("VTI")).toBe("VTI");
  });
});

describe("isExpiredOption", () => {
  it("is true only after the expiry date", () => {
    expect(isExpiredOption("AAPL260918C00250000", "2026-09-19")).toBe(true);
    expect(isExpiredOption("AAPL260918C00250000", "2026-09-18")).toBe(false);
    expect(isExpiredOption("AAPL260918C00250000", "2026-08-04")).toBe(false);
  });

  it("is never true for a share", () => {
    expect(isExpiredOption("VTI", "2030-01-01")).toBe(false);
  });
});

describe("isOptionSymbol", () => {
  it("separates contracts from tickers", () => {
    expect(isOptionSymbol("AAPL260918C00250000")).toBe(true);
    expect(isOptionSymbol("VTI")).toBe(false);
  });
});
