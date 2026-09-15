import { describe, expect, it } from "vitest";
import { resolveAnchoredDates, countAnchorsToPerson } from "./anchor";
import { scenarioSchema } from "./scenario";
import { mockScenario } from "@/lib/mockScenario";

const personId = "p1";
const base = () => ({
  household: { people: [{ id: personId, name: "A", birthDate: "1995-10-04", retirementAge: 55, planningEndAge: 95 }] },
  incomeSources: [],
  expenses: [],
  events: [],
  settings: {
    moneyFlow: {
      splitOrder: [{ id: "s1", accountId: "a1", startDate: null as string | null, endDate: null as string | null, endAnchor: { personId, point: "retirement" as const, offsetMonths: 0 } }],
      drainOrder: [{ id: "d1", accountId: "a2", startDate: null as string | null, endDate: null as string | null, startAnchor: { personId, point: "retirement" as const, offsetMonths: 1 } }],
    },
  },
});

describe("routing stops follow a retirement", () => {
  it("resolves a drain window from the owner's retirement", () => {
    const out = resolveAnchoredDates(base());
    // Retires 2050-10-04; the stop opens a month later.
    expect(out.settings.moneyFlow.drainOrder[0].startDate).toBe("2050-11-04");
  });

  it("resolves a split stop's end to the day before retirement", () => {
    const out = resolveAnchoredDates(base());
    expect(out.settings.moneyFlow.splitOrder[0].endDate).toBe("2050-10-03");
  });

  it("moves both when the retirement age changes", () => {
    const s = base();
    s.household.people[0].retirementAge = 52;
    const out = resolveAnchoredDates(s);
    expect(out.settings.moneyFlow.drainOrder[0].startDate).toBe("2047-11-04");
    expect(out.settings.moneyFlow.splitOrder[0].endDate).toBe("2047-10-03");
  });

  it("leaves an un-anchored stop's typed dates alone", () => {
    const s = base();
    s.settings.moneyFlow.drainOrder = [{ id: "d1", accountId: "a2", startDate: "2051-01-01", endDate: null, startAnchor: undefined as never }];
    const out = resolveAnchoredDates(s);
    expect(out.settings.moneyFlow.drainOrder[0].startDate).toBe("2051-01-01");
  });

  it("counts routing anchors in the 'if I move this, N things move' total", () => {
    expect(countAnchorsToPerson(base(), personId)).toBe(2);
  });

  it("still works for a scenario with no settings at all", () => {
    const { settings: _settings, ...noSettings } = base();
    expect(() => resolveAnchoredDates(noSettings)).not.toThrow();
  });
});

describe("schema round-trip", () => {
  it("keeps anchors on routing stops through a parse", () => {
    const parsed = scenarioSchema.parse({
      ...mockScenario,
      settings: {
        ...mockScenario.settings,
        moneyFlow: {
          splitOrder: [],
          drainOrder: [{
            id: "d1", accountId: mockScenario.accounts[0].id, kind: "percent_of_remainder", pct: 1,
            startAnchor: { personId: mockScenario.household.people[0].id, point: "retirement", offsetMonths: 1 },
          }],
        },
      },
    });
    expect(parsed.settings.moneyFlow.drainOrder[0].startAnchor).toEqual({
      personId: mockScenario.household.people[0].id, point: "retirement", offsetMonths: 1,
    });
    // ...and the parse chokepoint has already written the concrete date.
    expect(parsed.settings.moneyFlow.drainOrder[0].startDate).not.toBeNull();
  });

  it("defaults the anchors to absent so existing plans are untouched", () => {
    const parsed = scenarioSchema.parse(mockScenario);
    for (const stop of [...parsed.settings.moneyFlow.splitOrder, ...parsed.settings.moneyFlow.drainOrder]) {
      expect(stop.startAnchor ?? null).toBeNull();
      expect(stop.endAnchor ?? null).toBeNull();
    }
  });
});
