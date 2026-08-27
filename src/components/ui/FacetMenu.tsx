"use client";

import { useEffect, useRef, useState } from "react";

export interface FacetOption {
  value: string;
  label: string;
  /** How many rows this option currently matches, so picking between two
   *  near-empty options doesn't mean guessing which one does anything. */
  count: number;
}

export interface FacetState {
  mode: "include" | "exclude";
  /** Empty means "nothing chosen", which reads as no filter at all --
   *  distinct from choosing every option, which (in include mode) filters
   *  down to exactly what's chosen even if that happens to be everything
   *  currently present. */
  selected: ReadonlySet<string>;
}

export const EMPTY_FACET: FacetState = { mode: "include", selected: new Set() };

export function facetActive(facet: FacetState): boolean {
  return facet.selected.size > 0;
}

/** Whether `values` (a row's one or several tags for this facet) survive it. */
export function facetMatches(values: readonly string[], facet: FacetState): boolean {
  if (facet.selected.size === 0) return true;
  const hits = values.some((v) => facet.selected.has(v));
  return facet.mode === "include" ? hits : !hits;
}

/**
 * A condensed multi-select filter: one button that reads e.g. "Class · 2"
 * when narrowed, opening a checklist with per-option counts and an
 * include/exclude switch.
 *
 * The switch is what makes "hide my ETF exposure" a single click instead of
 * ticking every other instrument type: check ETF, flip to Hide, done -- the
 * alternative is remembering to re-check every box the fund lineup doesn't
 * currently include.
 */
export function FacetMenu({
  label,
  options,
  state,
  onChange,
}: {
  label: string;
  options: readonly FacetOption[];
  state: FacetState;
  onChange: (next: FacetState) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const active = facetActive(state);
  const toggle = (value: string) => {
    const next = new Set(state.selected);
    if (!next.delete(value)) next.add(value);
    onChange({ ...state, selected: next });
  };

  // Nothing to choose between. It stays on screen rather than unmounting: this
  // lives in the shared bar above the tabs now, and a control that vanishes as
  // a sibling facet narrows the rows makes the bar change shape under the
  // cursor. Disabled says the same thing and holds its place.
  const empty = options.length <= 1 && !active;

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={empty}
        title={empty ? `Nothing to filter by ${label.toLowerCase()} in this view` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-md border bg-panel-2 px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
          active ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
        } disabled:cursor-default disabled:border-border-soft disabled:text-dim-2 disabled:hover:text-dim-2`}
      >
        {label}
        {active ? ` · ${state.selected.size}` : ""} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-border bg-panel shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <div className="flex overflow-hidden rounded border border-border text-[10.5px]">
              {(["include", "exclude"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChange({ ...state, mode })}
                  className={`px-2 py-0.5 uppercase tracking-wide transition-colors ${
                    state.mode === mode
                      ? "bg-pri text-pri-fg"
                      : "bg-panel-2 text-dim-2 hover:text-foreground"
                  }`}
                >
                  {mode === "include" ? "Show" : "Hide"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...state, selected: new Set() })}
              className="text-[11px] text-dim-2 underline hover:text-foreground"
            >
              Clear
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-panel-2"
              >
                <input
                  type="checkbox"
                  checked={state.selected.has(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span className="flex-1 truncate text-foreground">{option.label}</span>
                <span className="text-dim-2 tabular-nums">{option.count}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
