import { describe, expect, it } from "vitest";
import {
  canonicalizeSymbol,
  contractMultiplier,
  formatOptionSymbol,
  isExpiredOption,
  isOptionSymbol,
  parseOptionSymbol,
  toOccSymbol,
  underlyingSymbol,
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

  it("reads an unpadded strike as plain dollars", () => {
    // The form a brokerage app shows: no padding, no thousandths. Reading "15"
    // as fifteen thousandths would misprice the contract by 1000x.
    expect(parseOptionSymbol("KLAR260508C15")).toEqual({
      underlying: "KLAR",
      expiry: "2026-05-08",
      right: "call",
      strike: 15,
    });
    expect(parseOptionSymbol("KLAR280121C17.5")?.strike).toBe(17.5);
  });

  it("reads a contract written out with slashes", () => {
    expect(parseOptionSymbol("KLAR 01/21/2028 17.50 C")).toEqual({
      underlying: "KLAR",
      expiry: "2028-01-21",
      right: "call",
      strike: 17.5,
    });
  });

  it("reads the other orders and spellings statements use", () => {
    const expected = { underlying: "KLAR", expiry: "2028-01-21", right: "put" as const, strike: 17.5 };
    expect(parseOptionSymbol("KLAR 2028-01-21 17.50 Put")).toEqual(expected);
    expect(parseOptionSymbol("KLAR 1/21/28 P 17.5")).toEqual(expected);
    expect(parseOptionSymbol("KLAR Jan 21 2028 17.50 PUT")).toEqual(expected);
  });

  it("reads back its own display format", () => {
    const canonical = "AAPL260918C00250000";
    expect(parseOptionSymbol(formatOptionSymbol(canonical))).toEqual(parseOptionSymbol(canonical));
  });

  it("rejects a written contract missing a piece", () => {
    expect(parseOptionSymbol("KLAR 01/21/2028 C")).toBeNull();
    expect(parseOptionSymbol("KLAR 01/21/2028 17.50")).toBeNull();
    expect(parseOptionSymbol("KLAR 01/32/2028 17.50 C")).toBeNull();
  });
});

describe("toOccSymbol", () => {
  it("pads the strike into the form the feed indexes", () => {
    expect(
      toOccSymbol({ underlying: "KLAR", expiry: "2028-01-21", right: "call", strike: 17.5 }),
    ).toBe("KLAR280121C00017500");
  });
});

describe("canonicalizeSymbol", () => {
  it("folds every spelling of one contract onto the same symbol", () => {
    for (const spelling of [
      "KLAR 01/21/2028 17.50 C",
      "KLAR280121C17.5",
      "KLAR280121C00017500",
      "  klar 01/21/2028 17.5 call  ",
    ]) {
      expect(canonicalizeSymbol(spelling)).toBe("KLAR280121C00017500");
    }
  });

  it("leaves an ordinary ticker alone but for case and space", () => {
    expect(canonicalizeSymbol(" vti ")).toBe("VTI");
    expect(canonicalizeSymbol("brk-b")).toBe("BRK-B");
  });
});

describe("underlyingSymbol", () => {
  it("names the ticker a contract is written on", () => {
    expect(underlyingSymbol("KLAR280121C00017500")).toBe("KLAR");
    expect(underlyingSymbol("VTI")).toBe("VTI");
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
