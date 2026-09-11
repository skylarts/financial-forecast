import { describe, expect, it } from "vitest";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "./performance";
import { reconcileValuations, summarizeReconciliation } from "./reconcile";

function point(date: string, value: number): PerformancePoint {
  return { date, value, flow: 0, index: 1 };
}

function statement(date: string, value: number): StatementValuation {
  return {
    id: `s-${date}`,
    accountId: "a1",
    date,
    value,
    contributions: null,
    income: null,
    note: "",
  };
}

describe("reconcileValuations", () => {
  it("reports the replay minus the statement, signed", () => {
    const rows = reconcileValuations(
      [statement("2026-01-31", 1000)],
      [point("2026-01-31", 1050)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drift).toBe(50);
    expect(rows[0].driftPct).toBeCloseTo(0.05);
  });

  it("compares against the last close on or before a weekend period end", () => {
    // 2026-01-31 is a Saturday; the statement was struck against Friday's close.
    const rows = reconcileValuations(
      [statement("2026-01-31", 1000)],
      [point("2026-01-30", 990), point("2026-02-02", 1200)],
    );
    expect(rows[0].replayedOn).toBe("2026-01-30");
    expect(rows[0].replayedValue).toBe(990);
    expect(rows[0].drift).toBe(-10);
  });

  it("never reaches forward to a later point", () => {
    const rows = reconcileValuations(
      [statement("2026-01-31", 1000)],
      [point("2026-02-02", 1200)],
    );
    expect(rows[0].replayedValue).toBeNull();
    expect(rows[0].drift).toBeNull();
  });

  it("keeps an uncomparable period rather than dropping it", () => {
    const rows = reconcileValuations(
      [statement("2020-01-31", 500), statement("2026-01-31", 1000)],
      [point("2026-01-31", 1000)],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].replayedValue).toBeNull();
    expect(rows[1].drift).toBe(0);
  });

  it("sorts by date regardless of input order", () => {
    const rows = reconcileValuations(
      [statement("2026-03-31", 3), statement("2026-01-31", 1), statement("2026-02-28", 2)],
      [],
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("gives no percentage against a closed-out account", () => {
    const rows = reconcileValuations([statement("2026-01-31", 0)], [point("2026-01-31", 12)]);
    expect(rows[0].drift).toBe(12);
    expect(rows[0].driftPct).toBeNull();
  });
});

describe("summarizeReconciliation", () => {
  it("picks the largest drift by absolute size, keeping its sign", () => {
    const rows = reconcileValuations(
      [statement("2026-01-31", 1000), statement("2026-02-28", 1000)],
      [point("2026-01-31", 1100), point("2026-02-28", 700)],
    );
    const summary = summarizeReconciliation(rows);
    expect(summary.compared).toBe(2);
    expect(summary.worst?.drift).toBe(-300);
    expect(summary.meanAbsPct).toBeCloseTo(0.2);
  });

  it("reports nothing compared when no row lines up", () => {
    const summary = summarizeReconciliation(reconcileValuations([statement("2026-01-31", 1)], []));
    expect(summary.compared).toBe(0);
    expect(summary.worst).toBeNull();
    expect(summary.meanAbsPct).toBeNull();
  });
});
