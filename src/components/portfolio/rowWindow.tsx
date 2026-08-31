"use client";

import { useState } from "react";

/**
 * How many rows a long table draws before it stops and asks.
 *
 * Every panel that lists the ledger used to render all of it. That is fine at
 * a few hundred rows and fatal at ten thousand: the browser builds a DOM node
 * per cell, so a 10,000-row transaction table is six figures of elements built
 * synchronously before anything paints, and every later keystroke in the
 * filter box rebuilds them. A workplace account's position is worse still --
 * years of per-paycheck buys mean the lot list behind a single holding can run
 * to tens of thousands of open lots.
 *
 * Matches the importer's own page size, which has used this pattern since it
 * had to preview files of the same size.
 */
export const ROW_PAGE = 250;

export interface RowWindow {
  /** How many rows of `key`'s list to draw. */
  limit: (key?: string) => number;
  /** Reveals `count` more rows of `key`'s list. */
  more: (count: number, key?: string) => void;
  /** Reveals all `total` rows of `key`'s list. */
  all: (total: number, key?: string) => void;
}

/**
 * Caps how much of a list is drawn, with the cap reset whenever the list
 * itself changes.
 *
 * `source` is whatever identifies the current list -- the rows array is the
 * natural choice, since every filter, sort, or ledger edit produces a new one.
 * Comparing it during render rather than resetting from an effect means a
 * filter change draws the first page immediately, instead of painting the
 * previous list's full expansion and then correcting itself.
 *
 * Lists are keyed so one hook can serve a grouped table, where each group
 * expands independently.
 */
export function useRowWindow(source: unknown): RowWindow {
  const [state, setState] = useState<{ source: unknown; shown: Record<string, number> }>({
    source,
    shown: {},
  });

  const shown = state.source === source ? state.shown : {};
  const limit = (key = "") => shown[key] ?? ROW_PAGE;
  const set = (key: string, value: number) =>
    setState({ source, shown: { ...shown, [key]: value } });

  return {
    limit,
    more: (count, key = "") => set(key, limit(key) + count),
    all: (total, key = "") => set(key, total),
  };
}

/**
 * The "showing some of many" line, with the two ways out of it.
 *
 * "Show all" is kept deliberately, even though it is the button that can hang
 * the tab on a very long list: filtering down to a few thousand rows and then
 * wanting every one of them is a real thing to want, and the count is printed
 * next to it so the choice is an informed one.
 */
export function MoreRows({
  shown,
  total,
  noun = "row",
  onMore,
  onAll,
}: {
  shown: number;
  total: number;
  noun?: string;
  onMore: (count: number) => void;
  onAll: () => void;
}) {
  const remaining = total - shown;
  if (remaining <= 0) return null;
  const step = Math.min(ROW_PAGE * 2, remaining);

  return (
    <span className="flex flex-wrap items-center gap-2 text-[11.5px] text-dim-2">
      <span>
        Showing {shown.toLocaleString()} of {total.toLocaleString()} {noun}s.
      </span>
      <button
        type="button"
        onClick={() => onMore(step)}
        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-dim hover:text-foreground"
      >
        Show {step.toLocaleString()} more
      </button>
      <button
        type="button"
        onClick={onAll}
        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-dim hover:text-foreground"
        title={`Draws all ${total.toLocaleString()} ${noun}s at once, which may take a moment on a long list.`}
      >
        Show all {total.toLocaleString()}
      </button>
    </span>
  );
}
