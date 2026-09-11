import type { ISODate } from "../../domain/common";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "./performance";

/**
 * One period end, with the statements totalled the same way the series is.
 *
 * `drift` is the replay minus the statements, so a positive number means the
 * tracker thinks the account was worth more than the custodian said.
 */
export interface ReconciliationRow {
  date: ISODate;
  /** Sum of every in-scope account's statement value for this period end. */
  statementValue: number;
  /** How many accounts that sum covers, so a total can be read as a total. */
  accounts: number;
  /** Null when the series has no point at or before this date to compare. */
  replayedValue: number | null;
  /** The series date actually compared, which may be earlier on a weekend. */
  replayedOn: ISODate | null;
  drift: number | null;
  driftPct: number | null;
}

export interface Reconciliation {
  rows: ReconciliationRow[];
  /** Accounts on screen that have no statements at all. */
  uncoveredAccounts: string[];
  /** Accounts on screen that do. */
  coveredAccounts: string[];
  /**
   * Period ends dropped because only some of the covered accounts had a value
   * for them -- a partial sum is not the account total and comparing it would
   * report a drift the size of whatever was missing.
   */
  datesSkipped: ISODate[];
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
 * Compares the statements against the replayed series, like against like.
 *
 * The series is one number for everything on screen, so the statements have to
 * be totalled to match it. Comparing a single account's statement against a
 * total spanning several reports a drift the size of the other accounts --
 * which is what this did before, and it made the whole panel useless the moment
 * more than one account was in view.
 *
 * A period end only counts when *every* account that has statements has one for
 * it. Accounts open at different times, so the brokerage has nothing for the
 * Roth's first year, and adding what exists would compare a partial sum against
 * a full total.
 *
 * Deliberately reports rather than corrects -- see {@link StatementValuation}.
 */
export function reconcileValuations(
  statements: readonly StatementValuation[],
  points: readonly PerformancePoint[],
  accountIdsInScope: readonly string[],
): Reconciliation {
  const inScope = new Set(accountIdsInScope);
  const relevant = statements.filter((s) => inScope.has(s.accountId));

  const coveredAccounts = [...new Set(relevant.map((s) => s.accountId))];
  const uncoveredAccounts = accountIdsInScope.filter((id) => !coveredAccounts.includes(id));

  // Last value wins per account-and-date, so a stray duplicate cannot double a
  // total. The importer already dedupes within one file; this covers the rest.
  const byDate = new Map<ISODate, Map<string, number>>();
  for (const s of relevant) {
    const forDate = byDate.get(s.date) ?? new Map<string, number>();
    forDate.set(s.accountId, s.value);
    byDate.set(s.date, forDate);
  }

  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows: ReconciliationRow[] = [];
  const datesSkipped: ISODate[] = [];

  for (const date of [...byDate.keys()].sort()) {
    const forDate = byDate.get(date) as Map<string, number>;
    if (forDate.size !== coveredAccounts.length) {
      datesSkipped.push(date);
      continue;
    }
    const statementValue = [...forDate.values()].reduce((a, b) => a + b, 0);
    const hit = valueOn(ordered, date);
    if (hit === null) {
      rows.push({
        date,
        statementValue,
        accounts: forDate.size,
        replayedValue: null,
        replayedOn: null,
        drift: null,
        driftPct: null,
      });
      continue;
    }
    const drift = hit.value - statementValue;
    rows.push({
      date,
      statementValue,
      accounts: forDate.size,
      replayedValue: hit.value,
      replayedOn: hit.on,
      drift,
      // A statement total of zero is a real state -- an account that closed out
      // -- and a percentage against it has no meaning.
      driftPct: statementValue === 0 ? null : drift / statementValue,
    });
  }

  return { rows, coveredAccounts, uncoveredAccounts, datesSkipped };
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
