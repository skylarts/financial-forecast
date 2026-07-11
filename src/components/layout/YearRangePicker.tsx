"use client";

const PRESETS = [5, 10, 20, 40] as const;

export function YearRangePicker({
  minYear,
  maxYear,
  rangeStart,
  rangeEnd,
  onChange,
}: {
  minYear: number;
  maxYear: number;
  rangeStart: number;
  rangeEnd: number;
  onChange: (start: number, end: number) => void;
}) {
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex flex-col gap-1 text-xs text-dim">
        From
        <select
          value={rangeStart}
          onChange={(e) => onChange(Number(e.target.value), rangeEnd)}
          className="rounded-md border border-border bg-panel px-2 py-1 text-sm text-foreground"
        >
          {years.filter((y) => y <= rangeEnd).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-dim">
        To
        <select
          value={rangeEnd}
          onChange={(e) => onChange(rangeStart, Number(e.target.value))}
          className="rounded-md border border-border bg-panel px-2 py-1 text-sm text-foreground"
        >
          {years.filter((y) => y >= rangeStart).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-1">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(rangeStart, Math.min(maxYear, rangeStart + n - 1))}
            className="rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
          >
            {n}y
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange(minYear, maxYear)}
          className="rounded-md border border-border px-2 py-1 text-xs text-dim hover:text-foreground"
        >
          Full
        </button>
      </div>
    </div>
  );
}
