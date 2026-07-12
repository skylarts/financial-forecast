import { describe, it, expect } from "vitest";
import { forecastSettingsSchema } from "./settings";

describe("forecastSettingsSchema -- filing status / tax defaults", () => {
  const base = {
    startDate: "2026-01-01",
    horizonEndDate: "2087-12-31",
    inflationRatePct: 0.03,
  };

  it("defaults filing status to marriedFilingJointly and the flat add-on to 0", () => {
    const parsed = forecastSettingsSchema.parse(base);
    expect(parsed.filingStatus).toBe("marriedFilingJointly");
    expect(parsed.additionalFlatTaxRatePct).toBe(0);
  });

  it("keeps explicit values the user provides", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      filingStatus: "single",
      additionalFlatTaxRatePct: 0.05,
    });
    expect(parsed.filingStatus).toBe("single");
    expect(parsed.additionalFlatTaxRatePct).toBe(0.05);
  });

  it("drops the old flat withdrawal-tax-rate fields from a stale saved plan instead of failing", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      withdrawalTaxRates: { taxDeferredPct: 0.3, taxablePct: 0.2, taxFreePct: 0 },
    });
    expect(parsed).not.toHaveProperty("withdrawalTaxRates");
  });
});

describe("forecastSettingsSchema -- moneyFlow defaults", () => {
  const base = {
    startDate: "2026-01-01",
    horizonEndDate: "2087-12-31",
    inflationRatePct: 0.03,
  };

  it("defaults to an empty waterfall (no hubs, no fill/drain order) when omitted", () => {
    const parsed = forecastSettingsSchema.parse(base);
    expect(parsed.moneyFlow).toEqual({ hubs: [], fillOrder: [], drainOrder: [], splitMode: "priority_fill" });
  });

  it("keeps an explicit moneyFlow configuration", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        hubs: [{ accountId: "checking", bufferAmount: 5000 }],
        fillOrder: [{ accountId: "savings", maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
        drainOrder: ["savings"],
        splitMode: "priority_fill",
      },
    });
    expect(parsed.moneyFlow.hubs).toHaveLength(1);
    expect(parsed.moneyFlow.hubs[0].bufferAmount).toBe(5000);
  });
});
