import type { ISODate } from "../../domain/common";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "./performance";

/**
 * One statement period end, next to what the replayed series made of that day.
 *
 * `drift` is the replay minus the statement, so a positive number means the
 * tracker thinks the account was worth more than the custodian said.
 */
export interface ReconciliationRow {
  date: ISODate;
  statementValue: number;
  /** Null when the series has no point at or before this date to compare. */
  replayedValue: number | null;
  /** The series date actually compared, which may be earlier on a weekend. */
  replayedOn: ISODate | null;
  drift: number | null;
  driftPct: number | null;
}

/**
 * A statement's period end can fall on a weekend or a holiday, when the series
 * has no point. The last close on or before it is the value the statement was
 * struck against, so that is what gets compared. Searching backwards rather
 * than to the nearest point in either direction matters: the nearest could be
 * the *next* trading day, which has a day of market move in it that the
 * statement could not have seen.
 */
function valueOn(
  points: readonly PerformancePoint[],
  date: ISODate,
): { value: number; on: ISODate } | null {
  let found: PerformancePoint | null = null;
  for (const p of points) {
    if (p.date > date) break;
    found = p;
  }
  return found === null ? null : { value: found.value, on: found.date };
}

/**
 * Pairs each statement valuation with the replayed account value on its date.
 *
 * Sorted by date, and deliberately reports rather than corrects -- see
 * {@link StatementValuation}. A row whose series has no matching point is kept
 * with a null replay so the gap is visible instead of silently dropped.
 */
export function reconcileValuations(
  statements: readonly StatementValuation[],
  points: readonly PerformancePoint[],
): ReconciliationRow[] {
  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return [...statements]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((s) => {
      const hit = valueOn(ordered, s.date);
      if (hit === null) {
        return {
          date: s.date,
          statementValue: s.value,
          replayedValue: null,
          replayedOn: null,
          drift: null,
          driftPct: null,
        };
      }
      const drift = hit.value - s.value;
      return {
        date: s.date,
        statementValue: s.value,
        replayedValue: hit.value,
        replayedOn: hit.on,
        drift,
        // A statement value of zero is a real state -- an account that closed
        // out -- and a percentage against it has no meaning.
        driftPct: s.value === 0 ? null : drift / s.value,
      };
    });
}

/** How far the replay strays from the statements, for a one-line summary. */
export interface ReconciliationSummary {
  compared: number;
  /** Largest absolute drift in dollars, and the row it came from. */
  worst: ReconciliationRow | null;
  /** Mean absolute drift as a share of statement value, over compared rows. */
  meanAbsPct: number | null;
}

export function summarizeReconciliation(rows: readonly ReconciliationRow[]): ReconciliationSummary {
  const compared = rows.filter((r) => r.drift !== null);
  if (compared.length === 0) return { compared: 0, worst: null, meanAbsPct: null };

  let worst = compared[0];
  for (const r of compared) {
    if (Math.abs(r.drift as number) > Math.abs(worst.drift as number)) worst = r;
  }
  const pcts = compared.filter((r) => r.driftPct !== null).map((r) => Math.abs(r.driftPct as number));
  return {
    compared: compared.length,
    worst,
    meanAbsPct: pcts.length === 0 ? null : pcts.reduce((a, b) => a + b, 0) / pcts.length,
  };
}
