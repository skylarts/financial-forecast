import { describe, expect, it } from "vitest";
import { normalizePlan, planHasContent, repairReferences, unwrapPlanEnvelope, PLAN_SCHEMA_VERSION } from "./planIO";
import { mockScenario } from "./mockScenario";
import { makeBlankScenario } from "./blankScenario";

function samplePlan() {
  return { id: "p", scenarios: [mockScenario], activeScenarioId: mockScenario.id };
}

describe("normalizePlan", () => {
  it("accepts the sample plan and stamps the schema version", () => {
    const r = normalizePlan(samplePlan());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.schemaVersion).toBe(PLAN_SCHEMA_VERSION);
    expect(r.repairs).toEqual([]);
  });

  it("lifts the sample plan's legacy stop caps onto the accounts, so the first session and a reload agree", () => {
    const r = normalizePlan(samplePlan());
    if (!r.ok) throw new Error(r.error);
    const s = r.plan.scenarios[0];
    const checking = s.accounts.find((a) => a.name === "Joint Checking")!;
    expect(checking.balanceCeiling).toBe(20_000);
    expect(s.settings.moneyFlow.splitOrder.every((stop) => stop.maxBalance == null)).toBe(true);
  });

  it("unwraps the zustand persist envelope", () => {
    const r = normalizePlan({ state: { plan: samplePlan() }, version: 0 });
    expect(r.ok).toBe(true);
    expect(unwrapPlanEnvelope({ state: { plan: 1 } })).toBe(1);
  });

  it("names the field when the schema rejects a plan", () => {
    const bad = samplePlan();
    const scenario = { ...bad.scenarios[0], household: { people: [{ ...bad.scenarios[0].household.people[0], retirementAge: 0 }] } };
    const r = normalizePlan({ ...bad, scenarios: [scenario] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.path).toContain("retirementAge");
    expect(r.error).toContain("retirementAge");
  });

  it("refuses things that are not plans without throwing", () => {
    expect(normalizePlan(null).ok).toBe(false);
    expect(normalizePlan("nope").ok).toBe(false);
    expect(normalizePlan([]).ok).toBe(false);
  });

  it("repairs a dangling active scenario id", () => {
    const r = normalizePlan({ ...samplePlan(), activeScenarioId: "missing" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.activeScenarioId).toBe(r.plan.scenarios[0].id);
    expect(r.repairs.some((x) => x.includes("active scenario"))).toBe(true);
  });
});

describe("repairReferences", () => {
  it("nulls optional references to missing accounts and drops events that need them", () => {
    const s = normalizePlan(samplePlan());
    if (!s.ok) throw new Error(s.error);
    const scenario = s.plan.scenarios[0];
    const brokerage = scenario.accounts.find((a) => a.name === "Joint Brokerage")!;
    const withoutBrokerage = { ...scenario, accounts: scenario.accounts.filter((a) => a.id !== brokerage.id) };
    const { scenario: repaired, repairs } = repairReferences(withoutBrokerage);
    // The inheritance was deposited into the brokerage: now lands on the hub.
    const inheritance = repaired.incomeSources.find((i) => i.name === "Inheritance")!;
    expect(inheritance.depositAccountId).toBeNull();
    // The buy_home event funded its down payment from the brokerage: removed.
    expect(repaired.events.some((e) => e.type === "buy_home")).toBe(false);
    // Routing stops that pointed at it are gone.
    expect(repaired.settings.moneyFlow.drainOrder.some((d) => d.accountId === brokerage.id)).toBe(false);
    expect(repairs.length).toBeGreaterThanOrEqual(3);
  });

  it("nulls retirement spending's missing payment account instead of dropping it", () => {
    const s = normalizePlan(samplePlan());
    if (!s.ok) throw new Error(s.error);
    const scenario = s.plan.scenarios[0];
    const person = scenario.household.people[0];
    const withSpending = {
      ...scenario,
      household: {
        people: scenario.household.people.map((p) =>
          p.id === person.id
            ? { ...p, retirementSpending: { amount: 1000, growthRatePct: null, paymentAccountId: "gone", endDate: null } }
            : p
        ),
      },
    };
    const { scenario: repaired, repairs } = repairReferences(withSpending);
    const fixed = repaired.household.people.find((p) => p.id === person.id);
    expect(fixed?.retirementSpending?.paymentAccountId).toBeNull();
    expect(repairs).toHaveLength(1);
  });

  it("returns the same object when nothing needs repair", () => {
    const s = normalizePlan(samplePlan());
    if (!s.ok) throw new Error(s.error);
    const scenario = s.plan.scenarios[0];
    expect(repairReferences(scenario).scenario).toBe(scenario);
  });
});

describe("planHasContent", () => {
  it("is false for the empty starting plan and true once anything is entered", () => {
    const blank = makeBlankScenario("My Plan");
    expect(planHasContent({ id: "p", scenarios: [blank], activeScenarioId: blank.id })).toBe(false);
    const withExpense = { ...blank, expenses: [{ ...mockScenario.expenses[0], paymentAccountId: null }] };
    expect(planHasContent({ id: "p", scenarios: [withExpense], activeScenarioId: blank.id })).toBe(true);
  });
});
