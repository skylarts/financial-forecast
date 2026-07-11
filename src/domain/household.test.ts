import { describe, it, expect } from "vitest";
import { householdSchema } from "./household";

describe("householdSchema", () => {
  it("accepts more than two people (regression: a hardcoded max(2) previously caused silent data loss on persistence reload once a 3rd person was added)", () => {
    const household = {
      people: [
        { id: "a", name: "A", birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 },
        { id: "b", name: "B", birthDate: "1991-01-01", retirementAge: 65, planningEndAge: 95 },
        { id: "c", name: "C", birthDate: "2020-01-01", retirementAge: 65, planningEndAge: 95 },
      ],
    };
    const result = householdSchema.safeParse(household);
    expect(result.success).toBe(true);
  });

  it("still requires at least one person", () => {
    const result = householdSchema.safeParse({ people: [] });
    expect(result.success).toBe(false);
  });
});
