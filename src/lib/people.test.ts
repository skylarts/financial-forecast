import { describe, expect, it } from "vitest";
import type { Person } from "@/domain/household";
import { ownerLabel, ownerOptions } from "./people";

const people: Person[] = [
  { id: "p1", name: "Skylar", birthDate: "1990-01-01", retirementAge: 52, planningEndAge: 95 },
  { id: "p2", name: "Hirva", birthDate: "1991-01-01", retirementAge: 52, planningEndAge: 95 },
];

describe("ownerLabel", () => {
  it("reads null as Joint", () => {
    expect(ownerLabel(people, null)).toBe("Joint");
  });

  it("resolves a known id to that person's name", () => {
    expect(ownerLabel(people, "p2")).toBe("Hirva");
  });

  it("reads a dangling id as Joint, not as a person", () => {
    expect(ownerLabel(people, "someone-removed")).toBe("Joint");
  });
});

describe("ownerOptions", () => {
  it("leads with Joint / none, then one option per person", () => {
    expect(ownerOptions(people)).toEqual([
      { value: "", label: "Joint / none" },
      { value: "p1", label: "Skylar" },
      { value: "p2", label: "Hirva" },
    ]);
  });
});
