"use client";

/**
 * How many rows survived the filters, and the way back out.
 *
 * Six tabs each grew their own version of this: three phrasings of the count
 * ("Showing 3 of 21", "9 of 9 names", none at all) and two shapes for the
 * escape hatch (an underline link on five, a button on Transactions). It is
 * the same sentence every time, so it reads the same way here.
 *
 * Renders nothing when no filter is active -- a count that always equals the
 * total is noise, and the clear link has nothing to clear.
 */
export function FilterStatus({
  shown,
  total,
  noun = "rows",
  active,
  onClear,
}: {
  shown: number;
  total: number;
  /** What is being counted, plural: "names", "rows", "lots". */
  noun?: string;
  /** Filters that narrow nothing right now still count as active -- a search
   *  matching everything should still offer the way back. */
  active: boolean;
  onClear: () => void;
}) {
  if (!active) return null;
  return (
    <span className="text-[11.5px] text-dim-2">
      {shown} of {total} {noun}
      <button type="button" onClick={onClear} className="ml-2 underline hover:text-foreground">
        Clear filters
      </button>
    </span>
  );
}
