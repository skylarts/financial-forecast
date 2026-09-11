"use client";

import { useMemo } from "react";
import type { StatementValuation } from "../../domain/portfolio/portfolio";
import type { PerformancePoint } from "../../engine/portfolio/performance";
import { reconcileValuations, summarizeReconciliation } from "../../engine/portfolio/reconcile";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;

const pct = (n: number | null) =>
  n === null ? "—" : `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(2)}%`;

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
  accountNames,
}: {
  statements: readonly StatementValuation[];
  points: readonly PerformancePoint[];
  /** Every account the series above covers. The statements are totalled to match. */
  accountIdsInScope: readonly string[];
  accountNames: Readonly<Record<string, string>>;
}) {
  const { rows, uncoveredAccounts, coveredAccounts, datesSkipped } = useMemo(
    () => reconcileValuations(statements, points, accountIdsInScope),
    [statements, points, accountIdsInScope],
  );
  const summary = useMemo(() => summarizeReconciliation(rows), [rows]);

  if (coveredAccounts.length === 0) return null;

  const material = rows.filter((r) => r.driftPct !== null && Math.abs(r.driftPct) >= MATERIAL_PCT);
  const name = (id: string) => accountNames[id] ?? "an account";
  const multi = coveredAccounts.length > 1;

  return (
    <div className="mt-5">
      {uncoveredAccounts.length > 0 && (
        <p className="mb-2 text-[11.5px] text-amber-400">
          {`No statements for ${uncoveredAccounts.map(name).join(", ")}, so the totals below cannot match what is on screen. Scope to ${coveredAccounts.map(name).join(" and ")}, or import statements for the rest.`}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                Against statements
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                {multi ? `Statements (${coveredAccounts.length})` : "Statement"}
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
              const tone = off ? "text-rose-400" : "text-dim-2";
              return (
                <tr key={r.date} className="border-b border-border-soft">
                  <td className="px-3 py-2 text-left text-[12.5px] text-dim">{r.date}</td>
                  <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-foreground">
                    {money(r.statementValue)}
                  </td>
                  <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-dim">
                    {r.replayedValue === null ? "—" : money(r.replayedValue)}
                  </td>
                  <td className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${tone}`}>
                    {r.drift === null ? "—" : signedMoney(r.drift)}
                  </td>
                  <td className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${tone}`}>
                    {pct(r.driftPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11.5px] text-dim-2">
        {summary.compared === 0
          ? "No statement period lines up with a day this tracker has priced. Load a longer history, or check the statement dates."
          : material.length === 0
            ? `Every one of ${summary.compared} periods agrees with this tracker to within half a percent. Drift is the tracker minus the statements.`
            : `${material.length} of ${summary.compared} periods differ from the custodian by more than half a percent — worst ${signedMoney(
                summary.worst?.drift ?? 0,
              )} on ${summary.worst?.date}. A drift is a missing trade, an unmodelled corporate action or a mispriced symbol, not something to correct here.`}
        {multi
          ? ` Each row totals the statements for ${coveredAccounts.map(name).join(" and ")}, because the series above is one number for all of them.`
          : ""}
      </p>

      {datesSkipped.length > 0 && (
        <p className="mt-1 text-[11.5px] text-dim-2">
          {`${datesSkipped.length} period${datesSkipped.length === 1 ? "" : "s"} left out because only some of these accounts had a statement for ${datesSkipped.length === 1 ? "it" : "them"} — ${datesSkipped[0]} to ${datesSkipped[datesSkipped.length - 1]}. Totalling part of the accounts would invent a drift the size of the rest.`}
        </p>
      )}
    </div>
  );
}
