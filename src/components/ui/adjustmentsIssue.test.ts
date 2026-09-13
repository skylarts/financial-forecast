import { describe, expect, it } from "vitest";
import { adjustmentsIssue } from "./AdjustmentsEditor";

describe("adjustmentsIssue", () => {
  it("accepts complete rows", () => {
    expect(adjustmentsIssue([{ id: "a", startDate: "2030-01-01", endDate: null, multiplier: 0.5 }])).toBeNull();
    expect(adjustmentsIssue([])).toBeNull();
  });
  it("names the row that is missing a start date, ends before it starts, or has a bad change", () => {
    expect(adjustmentsIssue([{ id: "a", startDate: "", endDate: null, multiplier: 1 }])).toMatch(/first temporary adjustment needs a start date/);
    expect(
      adjustmentsIssue([
        { id: "a", startDate: "2030-01-01", endDate: null, multiplier: 1 },
        { id: "b", startDate: "2031-01-01", endDate: "2030-06-01", multiplier: 1 },
      ])
    ).toMatch(/second temporary adjustment ends before it starts/);
    expect(adjustmentsIssue([{ id: "a", startDate: "2030-01-01", endDate: null, multiplier: -0.2 }])).toMatch(/change of −100% or more/);
  });
});
