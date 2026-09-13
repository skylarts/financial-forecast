import { describe, expect, it } from "vitest";
import { ageCurveFactor, applicablePercentage, irmaaTier, marketplaceNetMonthly, povertyLineFor } from "./healthcare";

describe("healthcare tables", () => {
  it("ages a premium along the federal curve", () => {
    expect(ageCurveFactor(21)).toBe(1);
    expect(ageCurveFactor(40)).toBeCloseTo(1.278, 3);
    expect(ageCurveFactor(64)).toBe(3);
    expect(ageCurveFactor(80)).toBe(3);
    expect(ageCurveFactor(5)).toBeCloseTo(0.765, 3);
  });

  it("finds the expected-contribution share by income, with the cliff under current law and none under the enhanced schedule", () => {
    expect(applicablePercentage(0.9, false)).toBeNull();
    expect(applicablePercentage(1.2, false)).toBeCloseTo(0.021, 4);
    expect(applicablePercentage(2.0, false)).toBeCloseTo(0.066, 4);
    expect(applicablePercentage(3.5, false)).toBeCloseTo(0.0996, 4);
    expect(applicablePercentage(4.5, false)).toBeNull();
    expect(applicablePercentage(1.2, true)).toBe(0);
    expect(applicablePercentage(3.5, true)).toBeCloseTo(0.0725, 4);
    expect(applicablePercentage(6, true)).toBeCloseTo(0.085, 4);
  });

  it("grows the poverty line with the household and inflation", () => {
    expect(povertyLineFor(1, 2026, 0)).toBe(15_650);
    expect(povertyLineFor(2, 2026, 0)).toBe(21_150);
    expect(povertyLineFor(2, 2027, 0.1)).toBeCloseTo(21_150 * 1.1, 6);
  });

  it("places income in the right IRMAA tier for each filing status", () => {
    expect(irmaaTier(100_000, "single", 2026, 0)).toBe(0);
    expect(irmaaTier(120_000, "single", 2026, 0)).toBe(1);
    expect(irmaaTier(250_000, "marriedFilingJointly", 2026, 0)).toBe(1);
    expect(irmaaTier(800_000, "marriedFilingJointly", 2026, 0)).toBe(5);
    // Thresholds index with inflation: the same income lands lower later.
    expect(irmaaTier(250_000, "marriedFilingJointly", 2036, 0.03)).toBe(0);
  });

  it("caps the marketplace premium at the household's expected contribution", () => {
    // Two people, $60k of income: 2.84x the poverty line, so about 9.5% of
    // income is expected -- $474 a month against a $1,500 benchmark.
    const r = marketplaceNetMonthly({ benchmarkMonthly: 1_500, acaMagi: 60_000, householdSize: 2, year: 2026, inflationRatePct: 0, premiumTaxCredit: true, enhancedSubsidies: false });
    expect(r.net).toBeCloseTo(473.7, 0);
    expect(r.credit).toBeCloseTo(1_500 - 473.7, 0);
    // Over four times the poverty line: full price.
    const rich = marketplaceNetMonthly({ benchmarkMonthly: 1_500, acaMagi: 200_000, householdSize: 2, year: 2026, inflationRatePct: 0, premiumTaxCredit: true, enhancedSubsidies: false });
    expect(rich.net).toBe(1_500);
    // Under the poverty line: no credit either (Medicaid territory).
    const poor = marketplaceNetMonthly({ benchmarkMonthly: 1_500, acaMagi: 10_000, householdSize: 2, year: 2026, inflationRatePct: 0, premiumTaxCredit: true, enhancedSubsidies: false });
    expect(poor.net).toBe(1_500);
    // Credit switched off: full price.
    const off = marketplaceNetMonthly({ benchmarkMonthly: 1_500, acaMagi: 60_000, householdSize: 2, year: 2026, inflationRatePct: 0, premiumTaxCredit: false, enhancedSubsidies: false });
    expect(off.net).toBe(1_500);
  });
});
