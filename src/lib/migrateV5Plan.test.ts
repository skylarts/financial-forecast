import { describe, expect, it } from "vitest";
import { migrateV5Plan, needsV5Migration } from "./migrateV5Plan";
import { normalizePlan } from "./planIO";
import { retirementDateOf } from "@/domain";

const alex = { id: "p1", name: "Alex", birthDate: "1990-05-15", retirementAge: 65, planningEndAge: 95 };

function planWith(events: unknown[], people = [alex]) {
  return {
    id: "plan",
    activeScenarioId: "s1",
    schemaVersion: 5,
    scenarios: [
      {
        id: "s1",
        name: "Plan",
        household: { people },
        accounts: [],
        incomeSources: [],
        expenses: [],
        events,
        settings: {
          startDate: "2026-01-01",
          horizonEndDate: "2060-12-31",
          inflationRatePct: 0.03,
          moneyFlow: { splitOrder: [], drainOrder: [] },
          rmdEnabled: true,
          filingStatus: "single",
          withdrawalStrategy: "custom",
        },
      },
    ],
  };
}

/** Pull the migrated scenario out, whatever shape the raw JSON came in as. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scenarioOf = (raw: unknown): any => (raw as any).scenarios[0];

describe("needsV5Migration", () => {
  it("fires only when a retire event is actually present", () => {
    expect(needsV5Migration(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2055-05-15", personId: "p1" }]))).toBe(true);
    expect(needsV5Migration(planWith([]))).toBe(false);
  });
});

describe("migrateV5Plan", () => {
  it("drops the event and leaves the age deriving the same date", () => {
    // 1990-05-15 + 65 years = 2055-05-15, exactly what the event said.
    const out = scenarioOf(migrateV5Plan(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2055-05-15", personId: "p1" }])));
    expect(out.events).toHaveLength(0);
    expect(out.household.people[0].retirementDate).toBeUndefined();
    expect(retirementDateOf(out.household.people[0])).toBe("2055-05-15");
  });

  it("keeps an exact date the age could not have produced", () => {
    const out = scenarioOf(migrateV5Plan(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2055-08-31", personId: "p1" }])));
    expect(out.household.people[0].retirementDate).toBe("2055-08-31");
    expect(retirementDateOf(out.household.people[0])).toBe("2055-08-31");
  });

  it("takes the event's own age override, and then derives from it", () => {
    const out = scenarioOf(
      migrateV5Plan(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2042-05-15", personId: "p1", retirementAge: 52 }]))
    );
    expect(out.household.people[0].retirementAge).toBe(52);
    expect(out.household.people[0].retirementDate).toBeUndefined();
    expect(retirementDateOf(out.household.people[0])).toBe("2042-05-15");
  });

  it("carries the retirement expense, the notes, and an excluded event's meaning", () => {
    const out = scenarioOf(
      migrateV5Plan(
        planWith([
          {
            id: "e1",
            type: "retire",
            name: "Alex retires",
            startDate: "2055-05-15",
            personId: "p1",
            isExcluded: true,
            notes: "Only if the pension vests",
            retirementExpense: { amount: 12_000, growthRatePct: 0, paymentAccountId: null, endDate: null },
          },
        ])
      )
    );
    const person = out.household.people[0];
    expect(person.skipRetirement).toBe(true);
    expect(person.retirementNotes).toBe("Only if the pension vests");
    expect(person.retirementSpending.amount).toBe(12_000);
    expect(retirementDateOf(person)).toBeNull();
  });

  it("keeps the earliest of several retire events, which is the one the engine acted on", () => {
    const out = scenarioOf(
      migrateV5Plan(
        planWith([
          { id: "e1", type: "retire", name: "Later", startDate: "2057-01-01", personId: "p1" },
          { id: "e2", type: "retire", name: "Earlier", startDate: "2050-03-01", personId: "p1" },
        ])
      )
    );
    expect(out.events).toHaveLength(0);
    expect(retirementDateOf(out.household.people[0])).toBe("2050-03-01");
  });

  it("leaves other event types alone", () => {
    const out = scenarioOf(
      migrateV5Plan(
        planWith([
          { id: "e1", type: "retire", name: "Alex retires", startDate: "2055-05-15", personId: "p1" },
          { id: "e2", type: "rollover", name: "Roll it over", startDate: "2056-01-01", fromAccountId: "a", toAccountId: "b", amount: null },
        ])
      )
    );
    expect(out.events.map((e: { type: string }) => e.type)).toEqual(["rollover"]);
  });

  it("runs as part of a normal load, and the loaded plan reports itself migrated", () => {
    const result = normalizePlan(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2055-05-15", personId: "p1" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toBe(true);
    expect(result.plan.scenarios[0].events).toHaveLength(0);
    expect(retirementDateOf(result.plan.scenarios[0].household.people[0])).toBe("2055-05-15");
  });

  it("leaves a person who never had a retire event alone -- their age now does the work", () => {
    const out = scenarioOf(migrateV5Plan(planWith([{ id: "e1", type: "retire", name: "Alex retires", startDate: "2055-05-15", personId: "p1" }], [
      alex,
      { id: "p2", name: "Sam", birthDate: "1992-01-01", retirementAge: 60, planningEndAge: 95 },
    ])));
    const sam = out.household.people[1];
    expect(sam.retirementDate).toBeUndefined();
    expect(sam.skipRetirement).toBeUndefined();
    expect(retirementDateOf(sam)).toBe("2052-01-01");
  });
});
