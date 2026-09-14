import { useMemo } from "react";
import type { ProjectionResult, Scenario } from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";
import { applicableStressPresets, stressPreset, type StressGroup, type StressKey, type StressParams } from "@/engine/stress";

export interface StressRun {
  key: StressKey;
  label: string;
  group: StressGroup;
  description: string;
  result: ProjectionResult;
}

/** One stressed projection, or null when no preset is chosen. Memoized on the scenario and the parameters. */
export function useStressProjection(scenario: Scenario, key: StressKey | null, params: StressParams): StressRun | null {
  return useMemo(() => {
    if (!key) return null;
    const preset = stressPreset(key);
    if (!preset || !preset.applies(scenario)) return null;
    const { scenario: stressed, options } = preset.apply(scenario, params);
    return { key, label: preset.label, group: preset.group, description: preset.describe(params, scenario), result: projectScenario(stressed, options) };
  }, [scenario, key, params]);
}

/** Every applicable preset run against the plan, for the Stress test tab. */
export function useStressSuite(scenario: Scenario, params: StressParams): StressRun[] {
  return useMemo(
    () =>
      applicableStressPresets(scenario).map((preset) => {
        const { scenario: stressed, options } = preset.apply(scenario, params);
        return { key: preset.key, label: preset.label, group: preset.group, description: preset.describe(params, scenario), result: projectScenario(stressed, options) };
      }),
    [scenario, params]
  );
}
