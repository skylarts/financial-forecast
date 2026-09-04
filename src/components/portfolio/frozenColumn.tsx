"use client";

import type { ReactNode } from "react";

/**
 * Freezing the label column on the wide portfolio tables.
 *
 * Holdings, Performance by stock, Realized and Transactions are all wider
 * than a phone and wider than a narrow window, so their numbers get read by
 * scrolling sideways -- and the symbol scrolled away with everything else,
 * leaving a row of figures belonging to nothing. The identifying column is
 * pinned instead, the way a spreadsheet freezes its first column. The
 * forecast tables have always done this; these four couldn't.
 *
 * What stopped them was `border-collapse`. A collapsed border belongs to the
 * table's grid rather than to the cell, so a sticky cell travels out from
 * under its own borders, and `position: sticky` on a `tr` only works at all
 * while the table is collapsed. So these tables are `border-separate` now,
 * and everything else here follows from that: row borders have to be drawn
 * per cell, and the sticky header and totals rows move off their `tr` and
 * onto the cells themselves.
 *
 * No constant here carries a `z-index`. Two of them land on one cell -- the
 * frozen column's header is also a sticky header cell -- and two `z-*`
 * classes on one element resolve by stylesheet order rather than by the
 * order they were written, which is not a thing to leave to luck.
 */
export const TABLE = "w-full border-separate border-spacing-0";

const FROZEN_PIN =
  // `border-r-border` spelled out because the row border these cells also
  // carry is the softer of the two weights, and a bare `border-border`
  // alongside it is two colour utilities racing on stylesheet order.
  "sticky left-0 z-[2] border-r border-r-border";

/**
 * The frozen column's body cell.
 *
 * Opaque, because the rest of the row passes underneath it -- which also
 * means it can't pick up the row's hover tint the way a transparent cell
 * does, hence `group-hover` here and `group` on the row. The pinning is kept
 * separate from the colour so that each of these cells names one plain
 * background and no more: two of those on one element resolve by stylesheet
 * order rather than by the order they were written.
 */
export const FROZEN_CELL = `${FROZEN_PIN} bg-panel group-hover:bg-panel-2`;

/**
 * The same cell on a row that carries a tint of its own -- a selected
 * transaction, say. The row's translucent tint can't just be left to show
 * through, because what is behind this cell is the rest of the table sliding
 * under it, so the tint is mixed into an opaque colour here instead.
 */
export const FROZEN_CELL_TINTED = `${FROZEN_PIN} bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel))]`;

/** The same cell on a group's header row, which is shaded to begin with. */
export const FROZEN_CELL_GROUP = `${FROZEN_PIN} bg-panel-2`;

/**
 * How wide the frozen column is allowed to get on a narrow screen.
 *
 * Uncapped it takes its width from its longest security name and from the
 * grouping control in its header -- around 235px, which is two thirds of a
 * phone and leaves the numbers nowhere to go, so freezing the column would
 * cost more than it bought. Applied to the cell's contents rather than to the
 * cell: a `max-width` on a table cell is a suggestion the browser may ignore,
 * while a capped box inside it genuinely shrinks what the column asks for.
 * Above `sm` there is room and the cap lifts.
 */
export const FROZEN_WIDTH = "max-w-[10rem] sm:max-w-none";

/** Pins a header or totals cell sideways, above its sticky neighbours. */
export const FROZEN_STICKY = "sticky left-0 z-20 border-r border-border";

const FOOT_BASE =
  "sticky bottom-0 border-t border-border bg-panel-2 px-3 py-2 text-[12.5px] font-semibold tabular-nums";

/** A cell in the totals row pinned to the bottom of the scroll area. */
export const FOOT = `${FOOT_BASE} z-10`;

/** That row's cell in the frozen column, pinned both ways. */
export const FOOT_FROZEN = `${FOOT_BASE} ${FROZEN_STICKY}`;

/**
 * Keeps a label put in a cell that spans the whole table -- the "show more
 * rows" footer under a long group. The cell can't be sticky itself without
 * sliding over the columns it spans, so its contents are, which parks the
 * label at the left edge as the table scrolls.
 *
 * Only for cells that span every column. A cell spanning some of them runs
 * out of containing block partway across, and a sticky child stops sticking
 * there and scrolls away with it -- which is what a group's label used to do,
 * and why it lives in `FrozenGroupLabel` below now.
 */
export function FrozenLabel({ children }: { children: ReactNode }) {
  return <div className="sticky left-0 w-fit">{children}</div>;
}

/**
 * A group's label, sitting in the frozen column and free to be wider than it.
 *
 * A group name and its row count are routinely wider than the column holding
 * them -- "Joint Brokerage 9 positions" over a column of dates -- so this
 * leans out across the empty columns beside it rather than being ellipsised
 * down to "Joint Broke...". Two nested boxes, because both halves of that are
 * needed at once:
 *
 * - the outer is `w-0`, so what it holds counts for nothing towards the
 *   column's width and a table of dates keeps a date-sized frozen column;
 * - the inner is opaque and only as wide as the label, so the figures in the
 *   scrolling columns pass behind it and are cut off at its edge, the way
 *   they are cut off by the frozen column's header.
 *
 * That lean-out assumes the trailing columns it crosses are empty. On a phone
 * they usually aren't -- the leading columns (Shares, Avg cost...) are too
 * narrow to hold the label, so it was reaching straight through them into the
 * first column with real figures (Value) and cutting those off mid-digit
 * instead of the blank space this was designed to cross. Capped to the same
 * width as the frozen column itself below `sm`, same as any other cell in it,
 * so the label just ellipsises there instead. Above `sm` there's room for the
 * lean-out to land on the blank columns it was meant for, so the cap lifts.
 */
export function FrozenGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="w-0">
      <div className={`w-max ${FROZEN_WIDTH} truncate bg-panel-2 pr-3`}>{children}</div>
    </div>
  );
}
