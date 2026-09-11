import { describe, expect, it } from "vitest";
import { maxDrawdown, netFlows, volatility, MIN_VOLATILITY_POINTS } from "./riskStats";

const day = (date: string, index: number) => ({ date, index });

describe("maxDrawdown", () => {
  it("finds the deepest fall from a running high, and when it recovered", () => {
    const out = maxDrawdown([
      day("2026-01-01", 1.0),
      day("2026-01-02", 1.2),
      day("2026-01-03", 1.0),
      day("2026-01-04", 0.9),
      day("2026-01-05", 1.1),
      day("2026-01-06", 1.25),
      day("2026-01-07", 1.2),
    ]);
    expect(out).toEqual({ depth: 0.9 / 1.2 - 1, peak: "2026-01-02", trough: "2026-01-04", recovered: "2026-01-06" });
  });

  it("reports an open drawdown as unrecovered", () => {
    const out = maxDrawdown([day("2026-01-01", 1.0), day("2026-01-02", 1.5), day("2026-01-03", 1.2)]);
    expect(out).toEqual({ depth: 1.2 / 1.5 - 1, peak: "2026-01-02", trough: "2026-01-03", recovered: null });
  });

  it("keeps the deeper of two drawdowns, whichever came first", () => {
    const out = maxDrawdown([
      day("2026-01-01", 1.0),
      day("2026-01-02", 0.95),
      day("2026-01-03", 1.1),
      day("2026-01-04", 0.8),
      day("2026-01-05", 1.2),
    ]);
    expect(out?.peak).toBe("2026-01-03");
    expect(out?.trough).toBe("2026-01-04");
    expect(out?.recovered).toBe("2026-01-05");
  });

  it("is null when the index only ever rose, or there is nothing to measure", () => {
    expect(maxDrawdown([day("2026-01-01", 1), day("2026-01-02", 1.1), day("2026-01-03", 1.2)])).toBeNull();
    expect(maxDrawdown([day("2026-01-01", 1)])).toBeNull();
  });
});

describe("volatility", () => {
  const steady = Array.from({ length: 300 }, (_, i) => day(`d${i}`, 1.001 ** i));
  const choppy = Array.from({ length: 300 }, (_, i) => day(`d${i}`, i % 2 === 0 ? 1 : 1.02));

  it("is near zero for a steady climb and large for a series that whipsaws", () => {
    const calm = volatility(steady)!;
    const wild = volatility(choppy)!;
    expect(calm).toBeCloseTo(0, 6);
    expect(wild).toBeGreaterThan(0.3);
  });

  it("refuses a window too short to mean anything", () => {
    expect(volatility(steady.slice(0, MIN_VOLATILITY_POINTS - 1))).toBeNull();
    expect(volatility(steady.slice(0, MIN_VOLATILITY_POINTS))).not.toBeNull();
  });
});

describe("netFlows", () => {
  it("separates money in from money out", () => {
    expect(netFlows([{ flow: 500 }, { flow: 0 }, { flow: -200 }, { flow: 100 }])).toEqual({ in: 600, out: 200, net: 400 });
  });
});
