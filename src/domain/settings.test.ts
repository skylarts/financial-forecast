import { describe, it, expect } from "vitest";
import { forecastSettingsSchema, DEFAULT_WITHDRAWAL_TAX_RATES } from "./settings";

describe("forecastSettingsSchema -- withdrawal tax defaults", () => {
  const defaultGrowthByClass = {
    cash: 0,
    taxable_investment: 0,
    tax_deferred: 0,
    tax_free: 0,
    real_estate: 0,
    other_asset: 0,
    credit_card: 0,
    loan: 0,
    mortgage: 0,
  };
  const base = {
    startDate: "2026-01-01",
    horizonEndDate: "2087-12-31",
    inflationRatePct: 0.03,
    defaultGrowthByClass,
    surplusRoutingRule: { mode: "priority_fill" as const },
  };

  it("fills in the default withdrawal tax rates when omitted", () => {
    const parsed = forecastSettingsSchema.parse(base);
    expect(parsed.withdrawalTaxRates).toEqual(DEFAULT_WITHDRAWAL_TAX_RATES);
    expect(parsed.withdrawalTaxRates.taxDeferredPct).toBe(0.22);
  });

  it("keeps explicit rates the user provides", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      withdrawalTaxRates: { taxDeferredPct: 0.3, taxablePct: 0.2, taxFreePct: 0 },
    });
    expect(parsed.withdrawalTaxRates.taxDeferredPct).toBe(0.3);
  });
});
