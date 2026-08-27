"use client";

import { useEffect, useRef, useState } from "react";
import type { FacetOption, FacetState } from "@/components/ui/facets";
import { facetActive } from "@/components/ui/facets";

export interface FilterSection<K extends string> {
  key: K;
  label: string;
  options: readonly FacetOption[];
  state: FacetState;
}

/**
 * Every filter behind one button, and what's on shown as chips beside it.
 *
 * Class, Theme and Type were three buttons of their own. Each said "Class · 2"
 * when narrowed, which tells you a filter exists but not what it is -- finding
 * that out meant opening the menu. Now they share a panel, and the answer is
 * on the outside: one chip per chosen value, each removable on its own.
 *
 * The panel keeps all three lists on screen together rather than nesting a
 * menu per section, so picking a class and then a theme is one visit.
 */
export function FilterMenu<K extends string>({
  sections,
  onChange,
  onClearAll,
}: {
  sections: readonly FilterSection<K>[];
  onChange: (key: K, next: FacetState) => void;
  onClearAll: () => void;
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

  const chosen = sections.reduce((n, s) => n + s.state.selected.size, 0);
  const anyOptions = sections.some((s) => s.options.length > 1);

  const toggle = (section: FilterSection<K>, value: string) => {
    const next = new Set(section.state.selected);
    if (!next.delete(value)) next.add(value);
    onChange(section.key, { ...section.state, selected: next });
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!anyOptions && chosen === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`rounded-md border bg-panel-2 px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
          chosen > 0 ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
        } disabled:cursor-default disabled:border-border-soft disabled:text-dim-2 disabled:hover:text-dim-2`}
      >
        Filters
        {chosen > 0 ? ` · ${chosen}` : ""} ▾
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filters"
          className="absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-panel shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-dim-2">
              Narrow the portfolio
            </span>
            <button
              type="button"
              onClick={onClearAll}
              disabled={chosen === 0}
              className="text-[11px] text-dim-2 underline hover:text-foreground disabled:no-underline disabled:opacity-40 disabled:hover:text-dim-2"
            >
              Clear all
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {sections.map((section) => (
              <section key={section.key} className="border-b border-border-soft last:border-b-0">
                <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
                  <span className="text-[11px] font-semibold text-foreground">{section.label}</span>
                  {/* Show/Hide is what makes "everything except my ETFs" one
                      click rather than ticking every other type. */}
                  <div className="flex overflow-hidden rounded border border-border text-[10px]">
                    {(["include", "exclude"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => onChange(section.key, { ...section.state, mode })}
                        className={`px-1.5 py-0.5 uppercase tracking-wide transition-colors ${
                          section.state.mode === mode
                            ? "bg-pri text-pri-fg"
                            : "bg-panel-2 text-dim-2 hover:text-foreground"
                        }`}
                      >
                        {mode === "include" ? "Show" : "Hide"}
                      </button>
                    ))}
                  </div>
                </div>
                {section.options.length === 0 ? (
                  <p className="px-3 pb-2 text-[11.5px] text-dim-2">
                    Nothing to filter by here.
                  </p>
                ) : (
                  <div className="pb-1">
                    {section.options.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] hover:bg-panel-2"
                      >
                        <input
                          type="checkbox"
                          checked={section.state.selected.has(option.value)}
                          onChange={() => toggle(section, option.value)}
                        />
                        <span className="flex-1 truncate text-foreground">{option.label}</span>
                        <span className="tabular-nums text-dim-2">{option.count}</span>
                      </label>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One chip per chosen value, so what's filtering is readable without opening
 * anything. A hidden facet reads "not Crypto" rather than "Crypto", because
 * the chip has to say what it's doing to the rows, not which box is ticked.
 */
export function FilterChips<K extends string>({
  sections,
  onChange,
}: {
  sections: readonly FilterSection<K>[];
  onChange: (key: K, next: FacetState) => void;
}) {
  const remove = (section: FilterSection<K>, value: string) => {
    const next = new Set(section.state.selected);
    next.delete(value);
    onChange(section.key, { ...section.state, selected: next });
  };

  return (
    <>
      {sections.flatMap((section) =>
        !facetActive(section.state)
          ? []
          : [...section.state.selected].map((value) => {
              const label = section.options.find((o) => o.value === value)?.label ?? value;
              return (
                <span
                  key={`${section.key}:${value}`}
                  className="flex items-center gap-1.5 rounded-full border border-accent bg-panel-2 py-0.5 pl-2.5 pr-1 text-[11.5px] text-accent"
                >
                  {section.state.mode === "exclude" && <span className="text-dim-2">not</span>}
                  {label}
                  <button
                    type="button"
                    onClick={() => remove(section, value)}
                    title={`Remove ${label}`}
                    className="px-1 text-dim-2 transition-colors hover:text-negative"
                  >
                    ✕
                  </button>
                </span>
              );
            }),
      )}
    </>
  );
}
