import { describe, it, expect } from "vitest";
import { expandOccurrences } from "./occurrences";

describe("expandOccurrences", () => {
  it("monthly generates one per month", () => {
    const occ = expandOccurrences("2026-01-15", null, "monthly", "2026-04-15");
    expect(occ).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
  });

  it("stops at endDate when earlier than horizon", () => {
    const occ = expandOccurrences("2026-01-01", "2026-02-15", "monthly", "2026-12-31");
    expect(occ).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("one_time produces exactly one occurrence", () => {
    const occ = expandOccurrences("2030-06-01", null, "one_time", "2090-01-01");
    expect(occ).toEqual(["2030-06-01"]);
  });

  it("annual steps by 12 months", () => {
    const occ = expandOccurrences("2026-03-01", null, "annual", "2029-03-01");
    expect(occ).toEqual(["2026-03-01", "2027-03-01", "2028-03-01", "2029-03-01"]);
  });

  it("returns empty when startDate is after the horizon", () => {
    const occ = expandOccurrences("2099-01-01", null, "monthly", "2090-01-01");
    expect(occ).toEqual([]);
  });

  it("intervalYears repeats every N years and overrides frequency", () => {
    // A car replaced every 7 years -- frequency is ignored when intervalYears is set.
    const occ = expandOccurrences("2026-05-01", null, "monthly", "2047-01-01", 7);
    expect(occ).toEqual(["2026-05-01", "2033-05-01", "2040-05-01"]);
  });

  it("intervalYears respects an end date", () => {
    const occ = expandOccurrences("2026-01-01", "2035-06-01", "one_time", "2090-01-01", 5);
    expect(occ).toEqual(["2026-01-01", "2031-01-01"]);
  });
});
