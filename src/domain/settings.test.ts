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

  it("defaults to an empty waterfall (no split/drain order) when omitted", () => {
    const parsed = forecastSettingsSchema.parse(base);
    expect(parsed.moneyFlow).toEqual({
      splitOrder: [],
      drainOrder: [],
      drainSplitMode: "priority_fill",
    });
  });

  it("keeps an explicit moneyFlow configuration", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        splitOrder: [
          { accountId: "savings", kind: "percent_of_remainder", amount: null, pct: 0.5, maxBalance: null, maxBalanceGrowthRatePct: null },
        ],
        drainOrder: [{ accountId: "savings", startDate: null, endDate: null, splitPct: null }],
        drainSplitMode: "priority_fill",
      },
    });
    expect(parsed.moneyFlow.splitOrder).toHaveLength(1);
    expect(parsed.moneyFlow.splitOrder[0].pct).toBe(0.5);
  });

  it("migrates a legacy plain-string drainOrder without losing data", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        splitOrder: [],
        drainOrder: ["savings", "brokerage"],
      },
    });
    expect(parsed.moneyFlow.drainOrder.map((d) => ({ ...d, id: undefined }))).toEqual([
      { id: undefined, accountId: "savings", startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
      { id: undefined, accountId: "brokerage", startDate: null, endDate: null, splitPct: null, minBalance: null, minBalanceGrowthRatePct: null },
    ]);
    // Each migrated entry gets its own freshly-generated, non-empty id.
    const ids = parsed.moneyFlow.drainOrder.map((d) => d.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults a split stop's kind to percent_of_remainder and accepts a flat amount", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        splitOrder: [
          { accountId: "roth_ira", kind: "flat", amount: 7500 },
          { accountId: "brokerage" },
        ],
        drainOrder: [],
      },
    });
    expect(parsed.moneyFlow.splitOrder[0]).toMatchObject({ kind: "flat", amount: 7500 });
    expect(parsed.moneyFlow.splitOrder[1]).toMatchObject({ kind: "percent_of_remainder", pct: null });
  });
});
