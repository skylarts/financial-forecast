import { describe, expect, it } from "vitest";
import {
  classifyTaxSource,
  sleeveTypeFor,
  suggestSleeve,
  taxSourceOfAccountType,
} from "./taxSource";

describe("classifyTaxSource", () => {
  it("reads the labels Empower actually prints", () => {
    expect(classifyTaxSource("EMPLOYEE BEFORE TAX-VOLUNTARY")).toBe("pretax");
    expect(classifyTaxSource("ROTH CONTRIBUTION")).toBe("roth");
  });

  it("reads the ordinary spellings of each pot", () => {
    expect(classifyTaxSource("Pre-tax")).toBe("pretax");
    expect(classifyTaxSource("pretax deferral")).toBe("pretax");
    expect(classifyTaxSource("Traditional")).toBe("pretax");
    expect(classifyTaxSource("After-tax Roth")).toBe("roth");
  });

  it("files employer money as pre-tax", () => {
    expect(classifyTaxSource("Employer Match")).toBe("pretax");
    expect(classifyTaxSource("Profit Sharing")).toBe("pretax");
  });

  it("lets Roth win a label that names both", () => {
    // A conversion row reads as Roth: that is the pot it lands in, which is
    // what the routing is deciding.
    expect(classifyTaxSource("Roth before-tax conversion")).toBe("roth");
  });

  it("says nothing rather than guessing at an unfamiliar label", () => {
    expect(classifyTaxSource("Rollover")).toBeNull();
    expect(classifyTaxSource("")).toBeNull();
    expect(classifyTaxSource("   ")).toBeNull();
  });
});

describe("sleeveTypeFor", () => {
  it("types a 401(k)'s sleeves as its two pots", () => {
    expect(sleeveTypeFor("traditional_401k", "pretax")).toBe("traditional_401k");
    expect(sleeveTypeFor("traditional_401k", "roth")).toBe("roth_401k");
  });

  it("gives a 457 the 401(k) pair, which is taxed the same way", () => {
    expect(sleeveTypeFor("other", "roth")).toBe("roth_401k");
    expect(sleeveTypeFor("taxable", "pretax")).toBe("traditional_401k");
  });

  it("keeps an IRA's sleeves IRAs", () => {
    expect(sleeveTypeFor("roth_ira", "pretax")).toBe("traditional_ira");
    expect(sleeveTypeFor("traditional_ira", "roth")).toBe("roth_ira");
  });
});

describe("taxSourceOfAccountType", () => {
  it("maps each tax-bucket type back to its pot", () => {
    expect(taxSourceOfAccountType("roth_401k")).toBe("roth");
    expect(taxSourceOfAccountType("traditional_ira")).toBe("pretax");
  });

  it("has nothing to say about a type that is not a tax bucket", () => {
    expect(taxSourceOfAccountType("taxable")).toBeNull();
    expect(taxSourceOfAccountType("hsa")).toBeNull();
  });
});

describe("suggestSleeve", () => {
  const sleeves = [
    { id: "pre", type: "traditional_401k" as const },
    { id: "roth", type: "roth_401k" as const },
  ];

  it("points a label at the sleeve holding that pot", () => {
    expect(suggestSleeve("EMPLOYEE BEFORE TAX-VOLUNTARY", sleeves)?.id).toBe("pre");
    expect(suggestSleeve("ROTH CONTRIBUTION", sleeves)?.id).toBe("roth");
  });

  it("suggests nothing for a label it cannot read", () => {
    expect(suggestSleeve("Rollover", sleeves)).toBeNull();
  });

  it("suggests nothing when no sleeve holds that pot", () => {
    expect(suggestSleeve("ROTH CONTRIBUTION", [sleeves[0]])).toBeNull();
  });
});
