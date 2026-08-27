import { describe, expect, it } from "vitest";
import { classifySecurity, type SecurityProfile } from "./classify";

function profile(patch: Partial<SecurityProfile>): SecurityProfile {
  return {
    symbol: "X",
    name: "",
    quoteType: "EQUITY",
    exchange: "NMS",
    exchangeName: "NasdaqGS",
    sector: "",
    category: "",
    ...patch,
  };
}

const classOf = (patch: Partial<SecurityProfile>) => classifySecurity(profile(patch)).assetClass;

describe("classifySecurity", () => {
  it("splits shares by where they're listed", () => {
    expect(classOf({ exchange: "NYQ", exchangeName: "NYSE" })).toBe("us_equity");
    expect(classOf({ exchange: "FRA", exchangeName: "Frankfurt" })).toBe("intl_equity");
  });

  it("files a REIT under real estate, not equity", () => {
    expect(classOf({ sector: "Real Estate" })).toBe("real_estate");
  });

  it("reads a fund's category", () => {
    expect(classOf({ quoteType: "ETF", category: "Large Blend" })).toBe("us_equity");
    expect(classOf({ quoteType: "ETF", category: "Foreign Large Blend" })).toBe("intl_equity");
    expect(classOf({ quoteType: "ETF", category: "Intermediate Core Bond" })).toBe("bond");
    expect(classOf({ quoteType: "ETF", category: "Real Estate" })).toBe("real_estate");
    expect(classOf({ quoteType: "ETF", category: "Commodities Focused" })).toBe("commodity");
    expect(classOf({ quoteType: "ETF", category: "Digital Assets" })).toBe("crypto");
    expect(classOf({ quoteType: "MUTUALFUND", category: "Money Market-Taxable" })).toBe("cash");
  });

  it("keeps what a fund holds ahead of where it holds it", () => {
    // A world bond fund is a bond fund. Reading the geography first would file
    // every foreign bond fund as international equity.
    expect(classOf({ quoteType: "ETF", category: "Global Bond" })).toBe("bond");
    expect(classOf({ quoteType: "ETF", category: "Global Real Estate" })).toBe("real_estate");
  });

  it("falls back to the fund's name when the feed has no category", () => {
    expect(classOf({ quoteType: "ETF", name: "Vanguard Total Bond Market ETF" })).toBe("bond");
    expect(classOf({ quoteType: "ETF", name: "Vanguard Total International Stock" })).toBe(
      "intl_equity",
    );
    expect(classOf({ quoteType: "ETF", name: "SPDR Gold Shares" })).toBe("commodity");
    // Nothing in the name to go on: a domestic stock fund is the safe guess,
    // and "other" would drop it out of the allocation view entirely.
    expect(classOf({ quoteType: "ETF", name: "Invesco QQQ Trust" })).toBe("us_equity");
  });

  it("reads the instrument kind when that settles it", () => {
    expect(classOf({ quoteType: "CRYPTOCURRENCY" })).toBe("crypto");
    expect(classOf({ quoteType: "CURRENCY" })).toBe("cash");
    expect(classOf({ quoteType: "FUTURE" })).toBe("commodity");
    expect(classOf({ quoteType: "INDEX" })).toBe("other");
  });

  it("always says what it read the class off", () => {
    expect(classifySecurity(profile({ quoteType: "ETF", category: "Large Blend" })).basis).toContain(
      "Large Blend",
    );
  });

  it("splits a world-stock fund across US and international, not just one", () => {
    // VT's actual Morningstar category.
    const result = classifySecurity(profile({ quoteType: "ETF", category: "World Large Stock" }));
    expect(result.assetClass).toBe("intl_equity");
    expect(result.exposures).toEqual([
      { assetClass: "us_equity", weight: 0.6 },
      { assetClass: "intl_equity", weight: 0.4 },
    ]);
  });

  it("keeps a region-specific fund single-class even when it says 'global'", () => {
    // Names a region (emerging markets) alongside "global", so it isn't a
    // whole-planet fund the way a plain "World Stock" category is.
    const result = classifySecurity(
      profile({ quoteType: "ETF", category: "Global Emerging Markets Stock" }),
    );
    expect(result.assetClass).toBe("intl_equity");
    expect(result.exposures).toEqual([{ assetClass: "intl_equity", weight: 1 }]);
  });

  it("gives every single-class result one full-weight exposure", () => {
    expect(classifySecurity(profile({ quoteType: "ETF", category: "Large Blend" })).exposures).toEqual([
      { assetClass: "us_equity", weight: 1 },
    ]);
    expect(classifySecurity(profile({ quoteType: "CRYPTOCURRENCY" })).exposures).toEqual([
      { assetClass: "crypto", weight: 1 },
    ]);
  });

  it("reads the instrument type off the quote type", () => {
    expect(classifySecurity(profile({ quoteType: "EQUITY" })).instrumentType).toBe("stock");
    expect(classifySecurity(profile({ quoteType: "ETF" })).instrumentType).toBe("etf");
    expect(classifySecurity(profile({ quoteType: "MUTUALFUND" })).instrumentType).toBe("mutual_fund");
    expect(classifySecurity(profile({ quoteType: "CRYPTOCURRENCY" })).instrumentType).toBe("crypto");
    expect(classifySecurity(profile({ quoteType: "CURRENCY" })).instrumentType).toBe("cash");
    expect(classifySecurity(profile({ quoteType: "INDEX" })).instrumentType).toBe("other");
  });
});
