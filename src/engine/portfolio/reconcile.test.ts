import { describe, expect, it } from "vitest";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "./performance";
import { reconcileValuations, summarizeReconciliation } from "./reconcile";

function point(date: string, value: number): PerformancePoint {
  return { date, value, flow: 0, index: 1 };
}

function statement(accountId: string, date: string, value: number): StatementValuation {
  return { id: `${accountId}-${date}`, accountId, date, value, contributions: null, income: null, note: "" };
}

describe("reconcileValuations", () => {
  it("reports the replay minus the statement, signed", () => {
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000)],
      [point("2026-01-31", 1050)],
      ["a"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drift).toBe(50);
    expect(rows[0].driftPct).toBeCloseTo(0.05);
    expect(rows[0].accounts).toBe(1);
  });

  it("totals the statements when several accounts are on screen", () => {
    // The series is one number for everything in view, so the statements have
    // to be summed to match it -- not compared one at a time against the total.
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000), statement("b", "2026-01-31", 250)],
      [point("2026-01-31", 1300)],
      ["a", "b"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].statementValue).toBe(1250);
    expect(rows[0].accounts).toBe(2);
    expect(rows[0].drift).toBe(50);
  });

  it("skips a period only some covered accounts reported", () => {
    // Accounts open at different times; adding what exists would compare a
    // partial sum against a full total and invent a drift.
    const { rows, datesSkipped } = reconcileValuations(
      [
        statement("a", "2026-01-31", 1000),
        statement("a", "2026-02-28", 1100),
        statement("b", "2026-02-28", 300),
      ],
      [point("2026-01-31", 1000), point("2026-02-28", 1400)],
      ["a", "b"],
    );
    expect(datesSkipped).toEqual(["2026-01-31"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-02-28");
    expect(rows[0].statementValue).toBe(1400);
    expect(rows[0].drift).toBe(0);
  });

  it("ignores statements for accounts not on screen", () => {
    const { rows, coveredAccounts } = reconcileValuations(
      [statement("a", "2026-01-31", 1000), statement("zzz", "2026-01-31", 90000)],
      [point("2026-01-31", 1000)],
      ["a"],
    );
    expect(coveredAccounts).toEqual(["a"]);
    expect(rows[0].statementValue).toBe(1000);
    expect(rows[0].drift).toBe(0);
  });

  it("names accounts on screen that have no statements", () => {
    const { uncoveredAccounts } = reconcileValuations(
      [statement("a", "2026-01-31", 1000)],
      [point("2026-01-31", 1000)],
      ["a", "b", "c"],
    );
    expect(uncoveredAccounts).toEqual(["b", "c"]);
  });

  it("does not let a duplicate row double a total", () => {
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000), statement("a", "2026-01-31", 1000)],
      [point("2026-01-31", 1000)],
      ["a"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].statementValue).toBe(1000);
    expect(rows[0].accounts).toBe(1);
  });

  it("compares against the last close on or before a weekend period end", () => {
    // 2026-01-31 is a Saturday; the statement was struck against Friday's close.
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000)],
      [point("2026-01-30", 990), point("2026-02-02", 1200)],
      ["a"],
    );
    expect(rows[0].replayedOn).toBe("2026-01-30");
    expect(rows[0].drift).toBe(-10);
  });

  it("never reaches forward to a later point", () => {
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000)],
      [point("2026-02-02", 1200)],
      ["a"],
    );
    expect(rows[0].replayedValue).toBeNull();
    expect(rows[0].drift).toBeNull();
  });

  it("sorts by date regardless of input order", () => {
    const { rows } = reconcileValuations(
      [
        statement("a", "2026-03-31", 3),
        statement("a", "2026-01-31", 1),
        statement("a", "2026-02-28", 2),
      ],
      [],
      ["a"],
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("gives no percentage against a closed-out account", () => {
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 0)],
      [point("2026-01-31", 12)],
      ["a"],
    );
    expect(rows[0].drift).toBe(12);
    expect(rows[0].driftPct).toBeNull();
  });
});

describe("summarizeReconciliation", () => {
  it("picks the largest drift by absolute size, keeping its sign", () => {
    const { rows } = reconcileValuations(
      [statement("a", "2026-01-31", 1000), statement("a", "2026-02-28", 1000)],
      [point("2026-01-31", 1100), point("2026-02-28", 700)],
      ["a"],
    );
    const summary = summarizeReconciliation(rows);
    expect(summary.compared).toBe(2);
    expect(summary.worst?.drift).toBe(-300);
    expect(summary.meanAbsPct).toBeCloseTo(0.2);
  });

  it("reports nothing compared when no row lines up", () => {
    const { rows } = reconcileValuations([statement("a", "2026-01-31", 1)], [], ["a"]);
    expect(summarizeReconciliation(rows).compared).toBe(0);
  });
});
