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
    expect(parsed.moneyFlow).toEqual({
      hubs: [],
      fillOrder: [],
      drainOrder: [],
      fillSplitMode: "priority_fill",
      drainSplitMode: "priority_fill",
    });
  });

  it("keeps an explicit moneyFlow configuration", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        hubs: [{ accountId: "checking", bufferAmount: 5000 }],
        fillOrder: [{ accountId: "savings", maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
        drainOrder: [{ accountId: "savings", startDate: null, endDate: null, splitPct: null }],
        fillSplitMode: "priority_fill",
        drainSplitMode: "priority_fill",
      },
    });
    expect(parsed.moneyFlow.hubs).toHaveLength(1);
    expect(parsed.moneyFlow.hubs[0].bufferAmount).toBe(5000);
  });

  it("migrates a legacy plain-string drainOrder and the old splitMode key without losing data", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        hubs: [{ accountId: "checking", bufferAmount: 5000 }],
        fillOrder: [],
        drainOrder: ["savings", "brokerage"],
        splitMode: "fixed_split",
      },
    });
    expect(parsed.moneyFlow.drainOrder.map((d) => ({ ...d, id: undefined }))).toEqual([
      { id: undefined, accountId: "savings", startDate: null, endDate: null, splitPct: null, minBalance: null },
      { id: undefined, accountId: "brokerage", startDate: null, endDate: null, splitPct: null, minBalance: null },
    ]);
    // Each migrated entry gets its own freshly-generated, non-empty id.
    const ids = parsed.moneyFlow.drainOrder.map((d) => d.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.moneyFlow.fillSplitMode).toBe("fixed_split");
    expect(parsed.moneyFlow.drainSplitMode).toBe("priority_fill");
  });

  it("folds a hub's dead self-referencing fill-order entry into its ceilingAmount", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        hubs: [{ accountId: "checking", bufferAmount: 50000 }],
        fillOrder: [
          { accountId: "checking", maxBalance: 100000, maxBalanceGrowthRatePct: null, splitPct: null },
          { accountId: "brokerage", maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null },
        ],
        drainOrder: [],
        fillSplitMode: "priority_fill",
        drainSplitMode: "priority_fill",
      },
    });
    expect(parsed.moneyFlow.hubs[0].ceilingAmount).toBe(100000);
    // The dead self-referencing entry is gone; the real fill target remains.
    expect(parsed.moneyFlow.fillOrder.map((f) => f.accountId)).toEqual(["brokerage"]);
  });

  it("leaves an explicit ceilingAmount alone even if a self-referencing entry is also present", () => {
    const parsed = forecastSettingsSchema.parse({
      ...base,
      moneyFlow: {
        hubs: [{ accountId: "checking", bufferAmount: 50000, ceilingAmount: 75000 }],
        fillOrder: [{ accountId: "checking", maxBalance: 100000, maxBalanceGrowthRatePct: null, splitPct: null }],
        drainOrder: [],
        fillSplitMode: "priority_fill",
        drainSplitMode: "priority_fill",
      },
    });
    expect(parsed.moneyFlow.hubs[0].ceilingAmount).toBe(75000);
  });
});
