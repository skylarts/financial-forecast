import { describe, expect, it } from "vitest";
import type { PerformancePoint, PricePoint } from "./performance";
import { isoYearBefore, summaryReturns } from "./summaryReturns";

/** A series growing a tenth of a percent a day between two dates, inclusive. */
function series(from: string, to: string): PerformancePoint[] {
  const points: PerformancePoint[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  let index = 1;
  while (cursor.getTime() <= end) {
    points.push({ date: cursor.toISOString().slice(0, 10), value: 1000 * index, flow: 0, index });
    index *= 1.001;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

const feedBackTo = (date: string): Map<string, PricePoint[]> =>
  new Map([["VTI", [{ date, close: 100 }, { date: "2026-08-04", close: 110 }]]]);

const at = (points: PerformancePoint[], date: string) => points.find((p) => p.date === date)!.index;

describe("summaryReturns", () => {
  const to = "2026-08-04";

  it("reads all four windows off one series when the feed covers them", () => {
    const points = series("2024-06-01", to);
    const out = summaryReturns(points, feedBackTo("2024-01-01"), to);
    const last = points[points.length - 1].index;
    expect(out.lifetime).toBeCloseTo(last / points[0].index - 1, 9);
    expect(out.ytd).toBeCloseTo(last / at(points, "2026-01-01") - 1, 9);
    expect(out.oneYear).toBeCloseTo(last / at(points, "2025-08-04") - 1, 9);
    expect(out.lifetimeCagr).not.toBeNull();
    expect(out.lifetimeCagr!).toBeLessThan(out.lifetime!);
  });

  it("refuses a one-year figure for a six-month-old account, but still gives its year to date", () => {
    const points = series("2026-02-01", to);
    const out = summaryReturns(points, feedBackTo("2024-01-01"), to);
    expect(out.oneYear).toBeNull();
    expect(out.ytd).toBeCloseTo(points[points.length - 1].index / points[0].index - 1, 9);
    expect(out.lifetime).toBe(out.ytd);
  });

  it("refuses year to date when the loaded prices start after January", () => {
    const points = series("2024-06-01", to);
    const out = summaryReturns(points, feedBackTo("2026-03-01"), to);
    expect(out.ytd).toBeNull();
    expect(out.oneYear).toBeNull();
    // Lifetime is measured against the series' own start, which exists only
    // because some history reached it.
    expect(out.lifetime).not.toBeNull();
  });

  it("is all null with nothing loaded", () => {
    const out = summaryReturns([], new Map(), to);
    expect(out).toEqual({ ytd: null, oneYear: null, lifetime: null, lifetimeCagr: null });
  });
});

describe("isoYearBefore", () => {
  it("steps back a calendar year", () => {
    expect(isoYearBefore("2026-08-04")).toBe("2025-08-04");
    expect(isoYearBefore("2024-02-29")).toBe("2023-03-01");
  });
});
