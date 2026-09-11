"use client";

import { useMemo } from "react";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "../../engine/portfolio/performance";
import { reconcileValuations, summarizeReconciliation } from "../../engine/portfolio/reconcile";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;

const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(2)}%`);

/**
 * How far off a drift has to be before it is worth chasing. Below this it is
 * a fractional share or a penny of rounding between the custodian and the feed;
 * above it, something is actually missing from the ledger.
 */
const MATERIAL_PCT = 0.005;

export function StatementReconciliation({
  statements,
  points,
  accountIdsInScope,
}: {
  statements: readonly StatementValuation[];
  points: readonly PerformancePoint[];
  /** Every account the series above covers, so partial statement coverage can be named. */
  accountIdsInScope: readonly string[];
}) {
  const rows = useMemo(() => reconcileValuations(statements, points), [statements, points]);
  const summary = useMemo(() => summarizeReconciliation(rows), [rows]);

  /**
   * A statement covers one account, but the series can span several. Comparing
   * one account's statement against a total that includes three others reports
   * an enormous drift that means nothing, so the mismatch is named rather than
   * left for the reader to infer from an absurd number.
   */
  const covered = new Set(statements.map((s) => s.accountId));
  const uncovered = accountIdsInScope.filter((id) => !covered.has(id)).length;

  if (statements.length === 0) return null;

  const material = rows.filter(
    (r) => r.driftPct !== null && Math.abs(r.driftPct) >= MATERIAL_PCT,
  );

  return (
    <div className="mt-5">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                Against statements
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                Statement
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                This tracker
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                Drift
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                %
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const off = r.driftPct !== null && Math.abs(r.driftPct) >= MATERIAL_PCT;
              return (
                <tr key={r.date} className="border-b border-border-soft">
                  <td className="px-3 py-2 text-left text-[12.5px] text-dim">{r.date}</td>
                  <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-foreground">
                    {money(r.statementValue)}
                  </td>
                  <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-dim">
                    {r.replayedValue === null ? "—" : money(r.replayedValue)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${
                      off ? "text-rose-400" : "text-dim-2"
                    }`}
                  >
                    {r.drift === null ? "—" : signedMoney(r.drift)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${
                      off ? "text-rose-400" : "text-dim-2"
                    }`}
                  >
                    {pct(r.driftPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {uncovered > 0 && (
        <p className="mt-2 text-[11.5px] text-amber-400">
          {`These statements cover ${covered.size} of the ${accountIdsInScope.length} accounts on screen, so the drift below compares one account's statement against a total that includes ${uncovered} other${uncovered === 1 ? "" : "s"}. Scope to that account, or import statements for the rest.`}
        </p>
      )}

      <p className="mt-2 text-[11.5px] text-dim-2">
        {summary.compared === 0
          ? "No statement period lines up with a day this tracker has priced. Load a longer history, or check the statement dates."
          : material.length === 0
            ? `Every one of ${summary.compared} statement periods agrees with this tracker to within half a percent. Drift is the tracker minus the statement.`
            : `${material.length} of ${summary.compared} periods differ from the custodian by more than half a percent — worst ${signedMoney(
                summary.worst?.drift ?? 0,
              )} on ${summary.worst?.date}. A drift is a missing trade, an unmodelled corporate action or a mispriced symbol, not something to correct here.`}
      </p>
    </div>
  );
}
