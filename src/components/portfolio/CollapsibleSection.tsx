"use client";

import { useState } from "react";
import { Chevron } from "./Chevron";

/**
 * A titled block under the allocation charts that folds away.
 *
 * Both blocks down here are setup work rather than reading material -- you
 * classify a holding or build a basket once and then spend months just looking
 * at the charts above. Folded, each costs one line of type; the summary on the
 * right keeps saying whatever the collapsed block would have told you at a
 * glance, so closing one doesn't hide the fact that there's something in it.
 */
export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** The right-hand line: a count, or a sentence saying what this is for.
   *  Shown whether the block is open or shut. */
  summary: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <h3 className="flex shrink-0 items-baseline gap-1.5 text-[13px] font-semibold text-foreground">
          <Chevron open={open} />
          {title}
        </h3>
        <span className="min-w-0 truncate text-right text-[11.5px] text-dim-2">{summary}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
