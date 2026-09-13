import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  countAnchorsToPerson,
  resolveAnchor,
  resolveAnchoredDates,
  resolveEndAnchor,
  retirementDateFor,
  type DateAnchor,
} from "./anchor";
import type { Person } from "./household";

const alex: Person = { id: "p1", name: "Alex", birthDate: "1990-05-15", retirementAge: 52, planningEndAge: 95 };
const jordan: Person = { id: "p2", name: "Jordan", birthDate: "1992-09-22", retirementAge: 60, planningEndAge: 95 };
const people = [alex, jordan];

const at = (personId: string, offsetMonths = 0): DateAnchor => ({ personId, point: "retirement", offsetMonths });

/** The minimum shape `resolveAnchoredDates` walks -- the real schemas are supersets of this. */
function scenario(overrides: Partial<Parameters<typeof resolveAnchoredDates>[0]> = {}) {
  return {
    household: { people },
    incomeSources: [] as Parameters<typeof resolveAnchoredDates>[0]["incomeSources"],
    expenses: [] as Parameters<typeof resolveAnchoredDates>[0]["expenses"],
    events: [] as Parameters<typeof resolveAnchoredDates>[0]["events"],
    ...overrides,
  };
}

describe("retirementDateFor", () => {
  it("falls back to the person's profile age when there is no retire event", () => {
    expect(retirementDateFor(people, [], "p1")).toBe("2042-05-15");
  });

  it("prefers a retire event, which may carry its own age override", () => {
    const events = [{ type: "retire", personId: "p1", startDate: "2044-01-01" }];
    expect(retirementDateFor(people, events, "p1")).toBe("2044-01-01");
  });

  it("takes the earliest retire event, matching the engine's own rule", () => {
    const events = [
      { type: "retire", personId: "p1", startDate: "2044-01-01" },
      { type: "retire", personId: "p1", startDate: "2041-06-01" },
    ];
    expect(retirementDateFor(people, events, "p1")).toBe("2041-06-01");
  });

  it("ignores an excluded retire event", () => {
    const events = [{ type: "retire", personId: "p1", startDate: "2044-01-01", isExcluded: true }];
    expect(retirementDateFor(people, events, "p1")).toBe("2042-05-15");
  });

  it("is null for someone who is not in the household", () => {
    expect(retirementDateFor(people, [], "ghost")).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("offsets by whole months in either direction", () => {
    expect(resolveAnchor(at("p1", 0), people, [])).toBe("2042-05-15");
    expect(resolveAnchor(at("p1", -24), people, [])).toBe("2040-05-15");
    expect(resolveAnchor(at("p1", 120), people, [])).toBe("2052-05-15");
  });

  it("resolves an END anchor to the day before, since endDate is inclusive", () => {
    expect(resolveEndAnchor(at("p1", 0), people, [])).toBe("2042-05-14");
  });
});

describe("resolveAnchoredDates", () => {
  it("rewrites a linked start date and leaves an unlinked one alone", () => {
    const next = resolveAnchoredDates(
      scenario({
        incomeSources: [
          { startDate: "2030-01-01", endDate: null, startAnchor: at("p1") },
          { startDate: "2026-01-01", endDate: null },
        ],
      })
    );
    expect(next.incomeSources[0].startDate).toBe("2042-05-15");
    expect(next.incomeSources[1].startDate).toBe("2026-01-01");
  });

  it("moves every linked date when a retirement age changes -- the whole point", () => {
    const base = scenario({
      incomeSources: [{ startDate: "x", endDate: null, startAnchor: at("p1") }], // pension starts at retirement
      expenses: [{ startDate: "x", endDate: "y", startAnchor: at("p1"), endAnchor: at("p1", 156) }], // healthcare bridge to 65
      events: [
        { type: "roth_conversion", startDate: "x", endDate: "y", startAnchor: at("p1"), endAnchor: at("p1", 180) },
      ],
    });

    const atFiftyTwo = resolveAnchoredDates(base);
    expect(atFiftyTwo.incomeSources[0].startDate).toBe("2042-05-15");
    expect(atFiftyTwo.expenses[0].endDate).toBe("2055-05-14");
    expect(atFiftyTwo.events[0].endDate).toBe("2057-05-14");

    // One edit -- the retirement age -- and all four dates follow.
    const later = resolveAnchoredDates({
      ...base,
      household: { people: [{ ...alex, retirementAge: 55 }, jordan] },
    });
    expect(later.incomeSources[0].startDate).toBe("2045-05-15");
    expect(later.expenses[0].startDate).toBe("2045-05-15");
    expect(later.expenses[0].endDate).toBe("2058-05-14");
    expect(later.events[0].endDate).toBe("2060-05-14");
  });

  it("never anchors a retire event to itself", () => {
    const next = resolveAnchoredDates(
      scenario({
        events: [{ type: "retire", personId: "p1", startDate: "2042-05-15", startAnchor: at("p1", 60) }],
      })
    );
    expect(next.events[0].startDate).toBe("2042-05-15");
  });

  it("keeps the last computed date when the linked person is gone, rather than blanking it", () => {
    const next = resolveAnchoredDates(
      scenario({ incomeSources: [{ startDate: "2042-05-15", endDate: null, startAnchor: at("ghost") }] })
    );
    expect(next.incomeSources[0].startDate).toBe("2042-05-15");
  });

  it("returns the very same object when nothing moved, so it is free to run on every edit", () => {
    const input = scenario({ incomeSources: [{ startDate: "2042-05-15", endDate: null, startAnchor: at("p1") }] });
    expect(resolveAnchoredDates(input)).toBe(input);
  });

  it("follows the retire event's date rather than the profile age when the two differ", () => {
    const next = resolveAnchoredDates(
      scenario({
        incomeSources: [{ startDate: "x", endDate: null, startAnchor: at("p1") }],
        events: [{ type: "retire", personId: "p1", startDate: "2040-01-01" }],
      })
    );
    expect(next.incomeSources[0].startDate).toBe("2040-01-01");
  });
});

describe("countAnchorsToPerson", () => {
  it("counts both ends of every linked item, and only for that person", () => {
    const s = {
      incomeSources: [{ startDate: "x", endDate: null, startAnchor: at("p1") }],
      expenses: [{ startDate: "x", endDate: "y", startAnchor: at("p1"), endAnchor: at("p2") }],
      events: [{ type: "retire", startDate: "x", startAnchor: at("p1") }],
    };
    expect(countAnchorsToPerson(s, "p1")).toBe(2);
    expect(countAnchorsToPerson(s, "p2")).toBe(1);
  });
});

describe("anchorLabel", () => {
  it("reads as a sentence", () => {
    expect(anchorLabel(at("p1"), people)).toBe("Alex's retirement");
    expect(anchorLabel(at("p1", -24), people)).toBe("2 years before Alex's retirement");
    expect(anchorLabel(at("p2", 60), people)).toBe("5 years after Jordan's retirement");
    expect(anchorLabel(at("p1", 8), people)).toBe("8 months after Alex's retirement");
  });
});
