"use client";

import { useEffect, useRef, useState } from "react";
import type { Granularity, Id } from "@/domain";
import type { DollarMode } from "@/lib/format";
import { Chip, Segmented } from "@/components/ui/controls";

const PRESETS = [5, 10, 20, 40] as const;

/** Month-range presets, in months. Capped by the engine's monthly window. */
const MONTH_PRESETS = [
  { months: 6, label: "6m" },
  { months: 12, label: "1y" },
  { months: 24, label: "2y" },
  { months: 36, label: "3y" },
  { months: 60, label: "5y" },
] as const;

const DOLLAR_OPTIONS = [
  { value: "nominal" as const, label: "Nominal" },
  { value: "real" as const, label: "Real" },
];

const GRANULARITY_OPTIONS = [
  { value: "year" as const, label: "Yearly" },
  { value: "month" as const, label: "Monthly" },
];

export interface MonthOption {
  key: string;
  label: string;
}

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
  granularity,
  onGranularityChange,
  granularityAvailable,
  monthOptions,
  monthStart,
  monthEnd,
  onMonthRangeChange,
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
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  /** Only the views that can render monthly columns offer the toggle at all. */
  granularityAvailable: boolean;
  /** Every month the engine produced detail for, oldest first. */
  monthOptions: MonthOption[];
  monthStart: string;
  monthEnd: string;
  onMonthRangeChange: (start: string, end: string) => void;
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

  const showMonths = granularityAvailable && granularity === "month" && monthOptions.length > 0;
  const startIndex = monthOptions.findIndex((m) => m.key === monthStart);
  const endIndex = monthOptions.findIndex((m) => m.key === monthEnd);
  const activeMonthPreset =
    startIndex >= 0 && endIndex >= 0 ? MONTH_PRESETS.find((p) => endIndex - startIndex + 1 === p.months) ?? null : null;
  /** Extend/shrink the window forward from the current start, clamped to what the engine produced. */
  const applyMonthPreset = (months: number) => {
    const from = Math.max(0, startIndex);
    onMonthRangeChange(monthOptions[from].key, monthOptions[Math.min(monthOptions.length - 1, from + months - 1)].key);
  };

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
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-panel px-3 py-2 sm:px-6 sm:py-2.5">
      {/* On a phone these controls wrapped into three stacked rows and ate a
          quarter of the viewport before any data showed. Each group instead
          stays on one line and scrolls sideways, bled to the screen edge; from
          `sm` up there's room to wrap as before. */}
      <div className="scroll-strip -mx-3 flex w-full flex-nowrap items-center gap-2 px-3 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0">
        {granularityAvailable && (
          <Segmented
            ariaLabel="Show one column per year or per month"
            options={GRANULARITY_OPTIONS}
            value={granularity}
            onChange={onGranularityChange}
            size="sm"
          />
        )}
        {showMonths ? (
          <>
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-dim-2">
              From
              <select
                value={monthStart}
                onChange={(e) => onMonthRangeChange(e.target.value, monthEnd)}
                className={selectClass}
              >
                {monthOptions
                  .filter((m) => m.key <= monthEnd)
                  .map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-dim-2">
              To
              <select
                value={monthEnd}
                onChange={(e) => onMonthRangeChange(monthStart, e.target.value)}
                className={selectClass}
              >
                {monthOptions
                  .filter((m) => m.key >= monthStart)
                  .map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex shrink-0 items-center gap-1">
              {MONTH_PRESETS.filter((p) => p.months <= monthOptions.length).map((p) => (
                <Chip key={p.months} active={activeMonthPreset?.months === p.months} onClick={() => applyMonthPreset(p.months)}>
                  {p.label}
                </Chip>
              ))}
            </div>
            <span className="hidden whitespace-nowrap text-[11.5px] text-dim-2 sm:inline">
              Monthly detail covers the first {Math.round(monthOptions.length / 12)} years of the plan.
            </span>
          </>
        ) : (
          <>
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-dim-2">
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
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-dim-2">
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
            <div className="flex shrink-0 items-center gap-1">
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
          </>
        )}
      </div>

      <div className="scroll-strip -mx-3 flex w-full flex-nowrap items-center gap-2 px-3 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0">
        {savedToBrowser && (
          <span className="hidden text-[11.5px] text-dim-2 sm:inline">Saved to this browser</span>
        )}
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
