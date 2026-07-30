"use client";

import { useEffect, useRef, useState } from "react";
import type { Id } from "@/domain";
import type { DollarMode } from "@/lib/format";
import { Chip, Segmented } from "@/components/ui/controls";

const PRESETS = [5, 10, 20, 40] as const;

const DOLLAR_OPTIONS = [
  { value: "nominal" as const, label: "Nominal" },
  { value: "real" as const, label: "Real" },
];

/**
 * The persistent control strip under the header.
 *
 * Everything here applies to *every* view, which is why it lives outside them:
 * the year range narrows the chart and both tables, and the nominal/real
 * switch changes how the tables render their figures. When the detail views
 * became top-level tabs these controls could no longer sit inside the chart,
 * or you'd be unable to change dollar mode while reading Cash Flow.
 */
export function ViewBar({
  minYear,
  maxYear,
  rangeStart,
  rangeEnd,
  onRangeChange,
  dollarMode,
  onDollarModeChange,
  compareOptions,
  compareScenarioId,
  onCompareChange,
  savedToBrowser,
}: {
  minYear: number;
  maxYear: number;
  rangeStart: number;
  rangeEnd: number;
  onRangeChange: (start: number, end: number) => void;
  dollarMode: DollarMode;
  onDollarModeChange: (m: DollarMode) => void;
  compareOptions: { id: Id; name: string }[];
  compareScenarioId: Id | null;
  onCompareChange: (id: Id | null) => void;
  savedToBrowser: boolean;
}) {
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  const isFullRange = rangeStart === minYear && rangeEnd === maxYear;
  const activePreset = PRESETS.find((n) => rangeEnd - rangeStart + 1 === n && !isFullRange) ?? null;

  const [compareOpen, setCompareOpen] = useState(false);
  const compareRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!compareOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (compareRef.current && !compareRef.current.contains(e.target as Node)) setCompareOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [compareOpen]);

  const compareName = compareOptions.find((o) => o.id === compareScenarioId)?.name ?? null;

  const selectClass =
    "rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[12px] text-foreground";

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-panel px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11.5px] text-dim-2">
          From
          <select
            value={rangeStart}
            onChange={(e) => onRangeChange(Number(e.target.value), rangeEnd)}
            className={selectClass}
          >
            {years
              .filter((y) => y <= rangeEnd)
              .map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-dim-2">
          To
          <select
            value={rangeEnd}
            onChange={(e) => onRangeChange(rangeStart, Number(e.target.value))}
            className={selectClass}
          >
            {years
              .filter((y) => y >= rangeStart)
              .map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          {PRESETS.map((n) => (
            <Chip
              key={n}
              active={activePreset === n}
              onClick={() => onRangeChange(rangeStart, Math.min(maxYear, rangeStart + n - 1))}
            >
              {n}y
            </Chip>
          ))}
          <Chip active={isFullRange} onClick={() => onRangeChange(minYear, maxYear)}>
            Full
          </Chip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {savedToBrowser && <span className="text-[11.5px] text-dim-2">Saved to this browser</span>}
        <Segmented
          ariaLabel="Show figures in future or today's dollars"
          options={DOLLAR_OPTIONS}
          value={dollarMode}
          onChange={onDollarModeChange}
          size="sm"
        />
        {compareOptions.length > 0 && (
          <div className="relative" ref={compareRef}>
            <button
              type="button"
              onClick={() => setCompareOpen((v) => !v)}
              className={`rounded-md border bg-panel-2 px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                compareName ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
              }`}
            >
              {compareName ? `vs ${compareName}` : "Compare"} ▾
            </button>
            {compareOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-border bg-panel p-1 shadow-lg">
                {compareOptions.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      onCompareChange(o.id);
                      setCompareOpen(false);
                    }}
                    className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent/15 ${
                      o.id === compareScenarioId ? "text-foreground" : "text-dim"
                    }`}
                  >
                    {o.name}
                  </button>
                ))}
                {compareName && (
                  <button
                    type="button"
                    onClick={() => {
                      onCompareChange(null);
                      setCompareOpen(false);
                    }}
                    className="mt-1 block w-full rounded border-t border-border px-3 py-2 pt-2 text-left text-sm text-dim hover:bg-accent/15"
                  >
                    Clear comparison
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
