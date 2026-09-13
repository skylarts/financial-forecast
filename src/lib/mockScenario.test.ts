import { describe, expect, it } from "vitest";
import { mockScenario } from "./mockScenario";
import { normalizePlan, PLAN_SCHEMA_VERSION } from "./planIO";
import { projectScenario } from "@/engine/forecastScenario";
import { firstShortfallYear } from "@/engine/planHealth";

/**
 * The sample plan must already be in the current on-disk shape: the first
 * session used to run it unparsed while every later load migrated it, so
 * the same plan showed two different projections.
 */
describe("the sample plan", () => {
  it("needs no migration and no repairs", () => {
    const result = normalizePlan({ id: "sample", schemaVersion: PLAN_SCHEMA_VERSION, activeScenarioId: mockScenario.id, scenarios: [mockScenario] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toBe(false);
    expect(result.repairs).toEqual([]);
    // Parsing changes nothing the engine reads.
    expect(result.plan.scenarios[0].settings).toEqual(mockScenario.settings);
    expect(result.plan.scenarios[0].accounts).toEqual(mockScenario.accounts);
  });

  it("projects cleanly to the end of the plan", () => {
    const r = projectScenario(mockScenario);
    expect(r.years.length).toBeGreaterThan(50);
    expect(firstShortfallYear(r)).toBeNull();
    expect(r.kpis.netWorthAtRetirement).toBeGreaterThan(0);
  });
});
