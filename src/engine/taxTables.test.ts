import { describe, expect, it } from "vitest";
import {
  TAX_TABLES_2026,
  bracketsForYear,
  marginalRate,
  progressiveTax,
  standardDeductionForYear,
  stackedLtcgTax,
  taxableSocialSecurity,
} from "./taxTables";

const MFJ_ORDINARY_2026 = TAX_TABLES_2026.ordinaryBrackets.marriedFilingJointly;
const MFJ_LTCG_2026 = TAX_TABLES_2026.ltcgBrackets.marriedFilingJointly;

describe("progressiveTax", () => {
  it("computes the $90k sole-401k-withdrawal example correctly (not a flat 22%)", () => {
    // $90k withdrawal, no other income, MFJ standard deduction ($32,200) -> $57,800 taxable.
    const taxableIncome = 90_000 - 32_200;
    const tax = progressiveTax(taxableIncome, MFJ_ORDINARY_2026);
    // 10% * 24,800 + 12% * (57,800 - 24,800)
    expect(tax).toBeCloseTo(2_480 + 12_000 * 0.12 + 21_000 * 0.12, 0);
    expect(tax).toBeCloseTo(6_440, 0);
    expect(tax / 90_000).toBeLessThan(0.08); // effective rate, nowhere near the old flat 22%
  });

  it("is zero at or below zero taxable income", () => {
    expect(progressiveTax(0, MFJ_ORDINARY_2026)).toBe(0);
    expect(progressiveTax(-100, MFJ_ORDINARY_2026)).toBe(0);
  });

  it("taxes the top bracket correctly with no upper bound", () => {
    const tax = progressiveTax(1_000_000, MFJ_ORDINARY_2026);
    // Everything above $768,700 is taxed at 37%.
    const belowTop = progressiveTax(768_700, MFJ_ORDINARY_2026);
    expect(tax).toBeCloseTo(belowTop + (1_000_000 - 768_700) * 0.37, 6);
  });
});

describe("marginalRate", () => {
  it("returns the correct bracket rate, inclusive of the upper boundary", () => {
    expect(marginalRate(24_800, MFJ_ORDINARY_2026)).toBeCloseTo(0.1, 6);
    expect(marginalRate(24_800.01, MFJ_ORDINARY_2026)).toBeCloseTo(0.12, 6);
    expect(marginalRate(57_800, MFJ_ORDINARY_2026)).toBeCloseTo(0.12, 6); // the $90k example's marginal rate
    expect(marginalRate(2_000_000, MFJ_ORDINARY_2026)).toBeCloseTo(0.37, 6);
  });
});

describe("stackedLtcgTax", () => {
  it("stays in the 0% band when ordinary income + gains stay under the threshold", () => {
    const { tax, marginalRate: rate } = stackedLtcgTax(57_800, 20_000, MFJ_LTCG_2026);
    expect(tax).toBe(0);
    expect(rate).toBe(0);
  });

  it("stacks gains on top of ordinary income across a bracket boundary", () => {
    const { tax, marginalRate: rate } = stackedLtcgTax(90_000, 30_000, MFJ_LTCG_2026);
    // 0% for the slice up to 98,900, 15% for the rest up to 120,000.
    expect(tax).toBeCloseTo((98_900 - 90_000) * 0 + (120_000 - 98_900) * 0.15, 2);
    expect(rate).toBeCloseTo(0.15, 6);
  });
});

describe("taxableSocialSecurity", () => {
  it("is untaxed below the base threshold", () => {
    expect(taxableSocialSecurity(20_000, 5_000, "marriedFilingJointly")).toBe(0);
  });

  it("applies the 50% tier between the base and additional thresholds", () => {
    // provisional income = 20,000 + 15,000 = 35,000 (between 32k and 44k base/additional)
    const taxable = taxableSocialSecurity(30_000, 20_000, "marriedFilingJointly");
    expect(taxable).toBeCloseTo(1_500, 2);
  });

  it("caps at 85% of benefits for high combined income", () => {
    const taxable = taxableSocialSecurity(40_000, 70_000, "marriedFilingJointly");
    expect(taxable).toBeCloseTo(34_000, 2); // 0.85 * 40,000
  });
});

describe("standardDeductionForYear", () => {
  it("matches the base 2026 MFJ deduction with no seniors", () => {
    const deduction = standardDeductionForYear([], "marriedFilingJointly", 2026, 0, 0);
    expect(deduction).toBeCloseTo(32_200, 2);
  });

  it("adds the age-65 bump and senior deduction per qualifying person", () => {
    const people = [{ birthDate: "1955-01-01" }, { birthDate: "1955-06-01" }];
    const deduction = standardDeductionForYear(people, "marriedFilingJointly", 2026, 0, 0);
    // base + 2*(age65 bump) + 2*(senior deduction, no phase-out at $0 other income)
    expect(deduction).toBeCloseTo(32_200 + 2 * 1_650 + 2 * 6_000, 2);
  });

  it("phases out the senior deduction above the threshold", () => {
    const people = [{ birthDate: "1955-01-01" }];
    const belowThreshold = standardDeductionForYear(people, "marriedFilingJointly", 2026, 0, 150_000);
    const aboveThreshold = standardDeductionForYear(people, "marriedFilingJointly", 2026, 0, 200_000);
    expect(aboveThreshold).toBeLessThan(belowThreshold);
  });
});

describe("bracketsForYear", () => {
  it("returns the base 2026 brackets unchanged in the base year", () => {
    const { ordinary } = bracketsForYear(2026, "marriedFilingJointly", 0.03);
    expect(ordinary[0].upTo).toBeCloseTo(24_800, 2);
  });

  it("inflates thresholds forward for later years", () => {
    const { ordinary } = bracketsForYear(2027, "marriedFilingJointly", 0.03);
    expect(ordinary[0].upTo).toBeCloseTo(24_800 * 1.03, 2);
  });
});
