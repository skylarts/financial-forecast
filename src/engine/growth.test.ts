import { describe, it, expect } from "vitest";
import { monthlyRateFromAnnual, growthAdjustedAmount } from "./growth";

describe("monthlyRateFromAnnual", () => {
  it("compounds 12 months back to the annual rate", () => {
    const monthly = monthlyRateFromAnnual(0.12);
    expect(Math.pow(1 + monthly, 12)).toBeCloseTo(1.12, 6);
  });
  it("is zero for a zero rate", () => {
    expect(monthlyRateFromAnnual(0)).toBe(0);
  });
});

describe("growthAdjustedAmount", () => {
  it("compounds at the nominal rate (matches the Python engine's verified 3%/yr numbers)", () => {
    // $4000/mo amount at 3%/yr nominal, verified against the prior Python engine.
    expect(growthAdjustedAmount(4000, 1, 0.03)).toBeCloseTo(4120, 0);
    expect(growthAdjustedAmount(4000, 10, 0.03)).toBeCloseTo(5375.67, 0);
  });
  it("stays flat in nominal terms at a 0 rate (real erosion is a display concern, not applied here)", () => {
    expect(growthAdjustedAmount(1000, 5, 0)).toBe(1000);
  });
  it("treats the entered rate as the full actual return", () => {
    // 7% nominal over 2 years, no separate inflation term added.
    expect(growthAdjustedAmount(1000, 2, 0.07)).toBeCloseTo(1000 * 1.07 * 1.07, 6);
  });
});
