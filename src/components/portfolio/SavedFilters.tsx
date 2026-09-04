"use client";

import { useEffect, useRef, useState } from "react";
import type { FacetState } from "@/components/ui/facets";
import { useSavedFilters, type SavedFilter } from "@/store/useSavedFilters";
import type { FilterSection } from "./FilterMenu";

/**
 * The bookmark next to the filter button: keep the combination you are looking
 * at now, and come back to it in one click later.
 *
 * "Her Roth, equities only, not crypto" takes four visits to four sections to
 * build, and it is the same four every time -- so the filters themselves were
 * the only memory the page had of a question the user asks weekly. A saved
 * combo is that question given a name.
 *
 * It saves the search box along with the facets, because a combo that
 * restored every filter except the text you had typed would leave the rows on
 * screen not matching the name you just clicked.
 */
export function SavedFilters<K extends string>({
  sections,
  search,
  onApply,
}: {
  sections: readonly FilterSection<K>[];
  search: string;
  onApply: (search: string, facets: Record<string, FacetState>) => void;
}) {
  const saved = useSavedFilters((s) => s.saved);
  const addSavedFilter = useSavedFilters((s) => s.addSavedFilter);
  const removeSavedFilter = useSavedFilters((s) => s.removeSavedFilter);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chosen = sections.reduce((n, s) => n + s.state.selected.size, 0);
  const canSave = chosen > 0 || search !== "";

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !canSave) return;
    addSavedFilter({
      name: trimmed,
      search,
      facets: Object.fromEntries(
        sections
          .filter((s) => s.state.selected.size > 0)
          .map((s) => [s.key, { mode: s.state.mode, selected: [...s.state.selected] }]),
      ),
    });
    setName("");
  };

  const apply = (filter: SavedFilter) => {
    onApply(
      filter.search,
      Object.fromEntries(
        Object.entries(filter.facets).map(([key, facet]) => [
          key,
          { mode: facet.mode, selected: new Set(facet.selected) },
        ]),
      ),
    );
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Saved filters"
        aria-label="Saved filters"
        className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-dim transition-colors hover:text-foreground"
      >
        <BookmarkIcon />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Saved filters"
          // Same escape hatch as the filter panel: on a phone this button sits
          // far enough right that a fixed-width panel hanging off its left
          // edge would run past the screen, and the page's `overflow-x: clip`
          // would quietly cut the half that hangs over.
          className="absolute left-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-border bg-panel shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:w-auto"
        >
          <div className="border-b border-border px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-dim-2">
            Saved filters
          </div>

          <div className="max-h-64 overflow-y-auto">
            {saved.length === 0 ? (
              <p className="px-3 py-2 text-[11.5px] text-dim-2">
                Nothing saved yet. Set up the filters you want, then name them below.
              </p>
            ) : (
              saved.map((filter) => (
                <div
                  key={filter.id}
                  className="flex items-center gap-1 border-b border-border-soft last:border-b-0 hover:bg-panel-2"
                >
                  <button
                    type="button"
                    onClick={() => apply(filter)}
                    className="min-w-0 flex-1 px-3 py-1.5 text-left"
                  >
                    <span className="block truncate text-[12px] text-foreground">
                      {filter.name}
                    </span>
                    <span className="block truncate text-[10.5px] text-dim-2">
                      {describe(filter, sections)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete "${filter.name}"?`)) removeSavedFilter(filter.id);
                    }}
                    title={`Delete ${filter.name}`}
                    className="px-2 py-1.5 text-dim-2 transition-colors hover:text-negative"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Saving lives at the bottom of the same panel rather than behind a
              second button, so "keep this one" and "go back to that one" are
              one place. Disabled with nothing filtered, because an empty combo
              would restore to the view you get by clearing everything. */}
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              disabled={!canSave}
              placeholder={canSave ? "Name these filters" : "No filters set"}
              aria-label="Name for the current filters"
              className="min-w-0 flex-1 rounded-md border border-border bg-panel-2 px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent disabled:opacity-50"
            />
            <button
              type="button"
              onClick={save}
              disabled={!canSave || name.trim() === ""}
              className="rounded-md border border-border bg-panel-2 px-2 py-1 text-[11.5px] font-medium text-dim transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-dim"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The one line under a combo's name, so the list is readable without applying
 * each entry to find out what it does. Values, not counts: "Roth, ETF" tells
 * you which one you want, "3 filters" does not.
 */
function describe<K extends string>(
  filter: SavedFilter,
  sections: readonly FilterSection<K>[],
): string {
  const parts = Object.entries(filter.facets).flatMap(([key, facet]) => {
    const section = sections.find((s) => s.key === key);
    return facet.selected.map((value) => {
      const label = section?.options.find((o) => o.value === value)?.label ?? value;
      return facet.mode === "exclude" ? `not ${label}` : label;
    });
  });
  if (filter.search !== "") parts.unshift(`"${filter.search}"`);
  return parts.length === 0 ? "No filters" : parts.join(", ");
}

/** Stroke art on the same 24x24 grid as the nav icons, in `currentColor` so it
 *  picks up the button's own resting and hover colors. */
function BookmarkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}
