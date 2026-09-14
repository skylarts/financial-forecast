import { describe, it, expect } from "vitest";
import { addMonths, ageOn, elapsedYears, eachMonthStart, endOfMonth } from "./dateMath";

describe("addMonths", () => {
  it("adds simple months", () => {
    expect(addMonths("2026-01-15", 1)).toBe("2026-02-15");
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
  });
  it("clamps day-of-month at month end (Jan 31 -> Feb 28)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  it("handles leap years", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });
});

describe("ageOn", () => {
  it("computes age before and after a birthday in the same year", () => {
    expect(ageOn("1990-05-15", "2026-05-14")).toBe(35);
    expect(ageOn("1990-05-15", "2026-05-15")).toBe(36);
    expect(ageOn("1990-05-15", "2026-05-16")).toBe(36);
  });
});

describe("elapsedYears", () => {
  it("is ~1.0 for a full calendar year", () => {
    expect(elapsedYears("2026-01-01", "2027-01-01")).toBeCloseTo(1.0, 2);
  });
  it("is ~0.5 for half a year", () => {
    expect(elapsedYears("2026-01-01", "2026-07-02")).toBeCloseTo(0.5, 1);
  });
});

describe("eachMonthStart", () => {
  it("yields one entry per month inclusive of both ends", () => {
    const months = [...eachMonthStart("2026-01-15", "2026-04-01")];
    expect(months).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });
});

/**
 * The hot-path rewrites (no Date allocation) must agree exactly with the
 * Date-based arithmetic they replaced, across month ends, leap days and
 * century boundaries -- elapsedYears bit-for-bit, since it feeds Math.pow.
 */
describe("date helpers match the Date-based reference", () => {
  const referenceAddMonths = (date: string, months: number) => {
    const [y, m, d] = date.split("-").map(Number);
    const total = m - 1 + months;
    const year = y + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    const day = Math.min(d, new Date(year, month + 1, 0).getDate());
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const referenceElapsed = (from: string, to: string) =>
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / (1000 * 60 * 60 * 24 * 365.25);
  const dates: string[] = [];
  for (const y of [1899, 1900, 1960, 1999, 2000, 2024, 2026, 2100, 2101]) {
    for (const m of [1, 2, 3, 6, 12]) for (const d of [1, 15, 28, 29, 30, 31]) {
      if (d > new Date(y, m, 0).getDate()) continue;
      dates.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  it("addMonths", () => {
    for (const date of dates) for (const n of [-25, -12, -1, 0, 1, 11, 12, 13, 240, 600]) expect(addMonths(date, n)).toBe(referenceAddMonths(date, n));
  });
  it("elapsedYears", () => {
    for (const a of dates) for (const b of dates) expect(elapsedYears(a, b)).toBe(referenceElapsed(a, b));
  });
  it("endOfMonth", () => {
    for (const date of dates) expect(endOfMonth(date.slice(0, 7))).toBe(`${date.slice(0, 7)}-${String(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0).getDate()).padStart(2, "0")}`);
  });
});
