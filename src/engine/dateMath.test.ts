import { describe, it, expect } from "vitest";
import { addMonths, ageOn, elapsedYears, eachMonthStart } from "./dateMath";

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
