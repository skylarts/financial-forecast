"use client";

import { useCallback, useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

/** Pulls the comparable value for a column out of a row. */
export type SortAccessors<T, K extends string> = Record<K, (row: T) => number | string>;

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * Column sorting for the portfolio tables.
 *
 * Clicking a new column starts it descending rather than ascending: every
 * numeric column here (value, gain, weight) is one where the interesting end is
 * the big end, and starting at the smallest rows would mean two clicks to see
 * anything useful. Text columns start ascending, where A–Z is the useful end.
 */
export function useSort<T, K extends string>(
  accessors: SortAccessors<T, K>,
  initialKey: K,
  initialDirection: SortDirection = "desc",
) {
  const [sort, setSort] = useState<SortState<K>>({ key: initialKey, direction: initialDirection });

  const toggle = useCallback(
    (key: K, sampleRow?: T) => {
      setSort((current) => {
        if (current.key === key) {
          return { key, direction: current.direction === "asc" ? "desc" : "asc" };
        }
        const isText = sampleRow !== undefined && typeof accessors[key](sampleRow) === "string";
        return { key, direction: isText ? "asc" : "desc" };
      });
    },
    [accessors],
  );

  const apply = useCallback(
    (rows: readonly T[]): T[] => {
      const read = accessors[sort.key];
      if (!read) return [...rows];
      const factor = sort.direction === "asc" ? 1 : -1;
      return [...rows].sort((a, b) => {
        const left = read(a);
        const right = read(b);
        if (typeof left === "string" || typeof right === "string") {
          return String(left).localeCompare(String(right)) * factor;
        }
        // NaN and null-ish figures (an unsolvable IRR, a missing quote) sort to
        // the bottom either way, so they never crowd out the real numbers.
        const leftBad = !Number.isFinite(left);
        const rightBad = !Number.isFinite(right);
        if (leftBad || rightBad) return leftBad && rightBad ? 0 : leftBad ? 1 : -1;
        return (left - right) * factor;
      });
    },
    [accessors, sort],
  );

  return useMemo(() => ({ sort, toggle, apply }), [sort, toggle, apply]);
}

/** Arrow marking the sorted column, blank on the rest. */
export function sortMarker<K extends string>(sort: SortState<K>, key: K): string {
  if (sort.key !== key) return "";
  return sort.direction === "asc" ? " ↑" : " ↓";
}
