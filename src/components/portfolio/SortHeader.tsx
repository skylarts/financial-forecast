"use client";

import type { ReactNode } from "react";
import { sortMarker, type SortState } from "./useSort";

export const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";

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
}) {
  // Written out rather than interpolated: Tailwind only ships classes it can
  // see as complete strings in the source.
  const alignClass = align === "left" ? "text-left" : "text-right";
  const justify = align === "left" ? "justify-start" : "justify-end";
  return (
    <th className={`${HEAD} ${alignClass}`} title={title}>
      <span className={`flex items-center gap-1.5 ${justify}`}>
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
