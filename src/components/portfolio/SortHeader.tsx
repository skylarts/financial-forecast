"use client";

import type { ReactNode } from "react";
import { FROZEN_STICKY } from "./frozenColumn";
import { sortMarker, type SortState } from "./useSort";

/**
 * A header cell. Sticky here rather than on the `thead > tr` that used to
 * carry it: these tables are `border-separate` so the label column can be
 * frozen, and a `tr` can't be sticky in a separated table. Carries no
 * `z-index` -- see `frozenColumn`.
 */
const HEAD_BASE =
  // `align-bottom` so that every label sits on the line directly above the
  // first row of data. The default centres them, and the leading column's
  // header is two lines tall on a phone, which left the rest of the labels
  // floating at a height nothing else in the table shared.
  "sticky top-0 border-b border-border bg-panel-2 px-3 py-2 align-bottom text-[11px] font-semibold uppercase tracking-wide text-dim-2";

export const HEAD = `${HEAD_BASE} z-10`;

/**
 * A sortable column heading.
 *
 * Four tables had written this out separately and identically, down to the
 * class strings; the only real variation was one of them accepting a tooltip.
 * `after` is the new part: the leading column of a groupable table hangs its
 * grouping menu here, so the control that reshapes the table sits in the
 * table.
 */
export function SortHeader<K extends string>({
  label,
  column,
  align,
  sort,
  onToggle,
  title,
  after,
  frozen = false,
}: {
  label: string;
  column: K;
  align: "left" | "right";
  sort: SortState<K>;
  onToggle: (column: K) => void;
  title?: string;
  /** Rendered beside the label, outside the sort button so clicking it doesn't
   *  also re-sort the table. */
  after?: ReactNode;
  /** Heads the frozen label column, so it pins sideways as well as down. */
  frozen?: boolean;
}) {
  // Written out rather than interpolated: Tailwind only ships classes it can
  // see as complete strings in the source.
  const alignClass = align === "left" ? "text-left" : "text-right";
  const justify = align === "left" ? "justify-start" : "justify-end";
  return (
    <th
      className={`${frozen ? `${HEAD_BASE} ${FROZEN_STICKY}` : HEAD} ${alignClass}`}
      title={title}
    >
      <span
        // The frozen column's header stays on one line, and the column widens
        // to hold it. It used to wrap instead, capped to a phone-sized width,
        // which stacked the grouping control under the column name and made
        // the header two lines tall on a phone -- a row of chrome above the
        // data that read as a second, emptier header. The column it widens is
        // the frozen one, so what it costs is scrolling, not anything hidden.
        className={`flex items-center gap-x-1.5 ${justify} ${frozen ? "whitespace-nowrap" : ""}`}
      >
        <button
          type="button"
          onClick={() => onToggle(column)}
          title={`Sort by ${label.toLowerCase()}`}
          className={`${alignClass} uppercase tracking-wide transition-colors hover:text-foreground ${
            sort.key === column ? "text-foreground" : ""
          }`}
        >
          {label}
          {sortMarker(sort, column)}
        </button>
        {after}
      </span>
    </th>
  );
}
