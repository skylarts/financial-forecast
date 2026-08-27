"use client";

import { Segmented } from "@/components/ui/controls";

export const OUTCOMES = [
  { value: "all", label: "All" },
  { value: "winners", label: "Winners" },
  { value: "losers", label: "Losers" },
] as const;

export type Outcome = (typeof OUTCOMES)[number]["value"];

/** Does this row count as a win, on the gain it was measured by? */
export function matchesOutcome(outcome: Outcome, gain: number): boolean {
  if (outcome === "winners") return gain > 0;
  if (outcome === "losers") return gain < 0;
  return true;
}

/**
 * Winners, losers, or everything -- shared by Realized and By stock.
 *
 * Worth keeping rather than leaning on a sort by the gain column: this filters,
 * so the stat cards above the table recompute against what's left. Sorting only
 * reorders, and would leave those totals covering rows you can no longer see.
 */
export function OutcomeFilter({
  value,
  onChange,
}: {
  value: Outcome;
  onChange: (next: Outcome) => void;
}) {
  return (
    <Segmented
      options={OUTCOMES}
      value={value}
      onChange={onChange}
      size="sm"
      ariaLabel="Filter by outcome"
    />
  );
}
