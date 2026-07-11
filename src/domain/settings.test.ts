import { describe, it, expect } from "vitest";
import { forecastSettingsSchema, DEFAULT_WITHDRAWAL_TAX_RATES } from "./settings";

describe("forecastSettingsSchema -- withdrawal tax defaults", () => {
  const base = {
    startDate: "2026-01-01",
    horizonEndDate: "2087-12-31",
    inflationRatePct: 0.03,
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
