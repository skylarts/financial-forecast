import type { ProjectionResult } from "@/domain";

/**
 * Plain-language readings of a projection: does the plan hold, and for how
 * long. Shared by the Overview tiles and the stress test.
 */

/** The first year the household could not cover its spending, or null when it never happens. */
export function firstShortfallYear(result: Pick<ProjectionResult, "warnings">): number | null {
  let first: number | null = null;
  for (const w of result.warnings) {
    if (w.kind !== "insufficient_funds") continue;
    if (first === null || w.year < first) first = w.year;
  }
  return first;
}

/** "End of plan" or "Runs short in 2063". */
export function holdsThroughLabel(result: Pick<ProjectionResult, "warnings">): string {
  const year = firstShortfallYear(result);
  return year === null ? "End of plan" : `Runs short in ${year}`;
}
