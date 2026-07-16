"use client";

import { useState } from "react";
import { nanoid } from "nanoid";
import type { Account, ForecastSettings, MoneyFlow } from "@/domain";
import { forecastSettingsSchema } from "@/domain";
import { ErrorBanner, InfoTooltip } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

/**
 * Cash-flow routing, edited from one place instead of scattered per-account
 * fields. There's no user-configurable "spending account" here anymore --
 * Extra Savings (see the Accounts tab; it can't be deleted) is the one
 * mandatory hub: income deposits there, expenses pay from there, it captures
 * 100% of net income-minus-expenses every month with a floor hardcoded at
 * $0. The two lists below decide what happens with that money: `splitOrder`
 * is where surplus goes (each stop a flat $ amount or a cascading % of
 * what's left after the stops above it), `drainOrder` is what covers a
 * shortfall, unchanged from before.
 */
export function MoneyFlowEditor({ accounts, settings }: { accounts: Account[]; settings: ForecastSettings }) {
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const moneyFlow = settings.moneyFlow;
  const extraSavingsId = accounts.find((a) => a.isExtraSavings)?.id;

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "(deleted account)";
  const availableAccounts = (excludeIds: Set<string>) => accounts.filter((a) => !excludeIds.has(a.id));

  const save = (next: MoneyFlow) => {
    const result = forecastSettingsSchema.safeParse({ ...settings, moneyFlow: next });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid money flow configuration.");
      return;
    }
    setError(null);
    updateSettings(result.data);
  };

  // --- Extra Savings split (surplus routing) ---
  // A stop pointing at Extra Savings itself would always be a no-op (the
  // engine skips an account sweeping into itself), so it's excluded from the
  // add list, same as any other self-reference guard in this editor.
  const splitIds = new Set(moneyFlow.splitOrder.map((f) => f.accountId));
  const addSplitStop = (accountId: string) => {
    if (!accountId) return;
    save({
      ...moneyFlow,
      splitOrder: [
        ...moneyFlow.splitOrder,
        { id: nanoid(), accountId, kind: "percent_of_remainder", amount: null, pct: 1, maxBalance: null, maxBalanceGrowthRatePct: null },
      ],
    });
  };
  const updateSplitStop = (id: string, patch: Partial<MoneyFlow["splitOrder"][number]>) =>
    save({
      ...moneyFlow,
      splitOrder: moneyFlow.splitOrder.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  const removeSplitStop = (id: string) =>
    save({ ...moneyFlow, splitOrder: moneyFlow.splitOrder.filter((s) => s.id !== id) });
  const moveSplitStop = (index: number, dir: -1 | 1) => {
    const next = [...moneyFlow.splitOrder];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save({ ...moneyFlow, splitOrder: next });
  };

  // --- Drain order (deficit cascade) ---
  // Unlike the split list, the SAME account can appear more than once here
  // (different date windows) -- so entries are keyed by their own `id`, not
  // by accountId, and the "add" list intentionally doesn't exclude accounts
  // already in the list.
  const addDrainSource = (accountId: string) => {
    if (!accountId) return;
    save({
      ...moneyFlow,
      drainOrder: [
        ...moneyFlow.drainOrder,
        { id: nanoid(), accountId, startDate: null, endDate: null, splitPct: null, minBalance: null },
      ],
    });
  };
  const updateDrainStop = (id: string, patch: Partial<MoneyFlow["drainOrder"][number]>) =>
    save({
      ...moneyFlow,
      drainOrder: moneyFlow.drainOrder.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    });
  const removeDrainSource = (id: string) =>
    save({ ...moneyFlow, drainOrder: moneyFlow.drainOrder.filter((d) => d.id !== id) });
  const moveDrainSource = (index: number, dir: -1 | 1) => {
    const next = [...moneyFlow.drainOrder];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save({ ...moneyFlow, drainOrder: next });
  };
  const setDrainSplitMode = (drainSplitMode: MoneyFlow["drainSplitMode"]) => {
    const drainOrder =
      drainSplitMode === "fixed_split"
        ? moneyFlow.drainOrder.map((d) => ({ ...d, splitPct: d.splitPct ?? 1 / Math.max(1, moneyFlow.drainOrder.length) }))
        : moneyFlow.drainOrder;
    save({ ...moneyFlow, drainSplitMode, drainOrder });
  };
  const drainSplitTotal = moneyFlow.drainOrder.reduce((s, d) => s + (d.splitPct ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner message={error} />

      {/* Extra Savings split */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
          When there&rsquo;s extra cash, split it
          <InfoTooltip text="Order is priority -- the first stop is offered first. Each stop is a flat dollar amount or a percentage of what's left after the stops above it (cascading, not a share of the total). Whatever the list doesn't claim stays in Extra Savings." />
        </h3>
        {moneyFlow.splitOrder.length === 0 && <p className="text-xs text-dim">No surplus targets configured yet.</p>}
        {moneyFlow.splitOrder.map((stop, i) => (
          <div key={stop.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button type="button" disabled={i === 0} onClick={() => moveSplitStop(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
                <button type="button" disabled={i === moneyFlow.splitOrder.length - 1} onClick={() => moveSplitStop(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
              </div>
              <span className="flex-1 truncate text-sm">{i + 1}. {accountName(stop.accountId)}</span>
              <button type="button" onClick={() => removeSplitStop(stop.id)} className="text-xs text-negative hover:underline">
                Remove
              </button>
            </div>
            <div className="ml-6 flex flex-wrap items-center gap-3 text-xs text-dim">
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => updateSplitStop(stop.id, { kind: "flat" })}
                  className={`rounded px-2 py-0.5 ${stop.kind === "flat" ? "bg-accent text-white" : "text-dim"}`}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => updateSplitStop(stop.id, { kind: "percent_of_remainder" })}
                  className={`rounded px-2 py-0.5 ${stop.kind === "percent_of_remainder" ? "bg-accent text-white" : "text-dim"}`}
                >
                  %
                </button>
              </div>
              {stop.kind === "flat" ? (
                <label className="flex items-center gap-1">
                  Amount $
                  <input
                    className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    type="number"
                    step="0.01"
                    placeholder="0"
                    value={stop.amount ?? ""}
                    onChange={(e) => updateSplitStop(stop.id, { amount: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
              ) : (
                <label className="flex items-center gap-1">
                  Share
                  <input
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    value={stop.pct == null ? "" : Math.round(stop.pct * 100)}
                    onChange={(e) =>
                      updateSplitStop(stop.id, { pct: e.target.value === "" ? null : Number(e.target.value) / 100 })
                    }
                  />
                  % of remainder
                </label>
              )}
              <label className="flex items-center gap-1">
                Cap $
                <InfoTooltip text="How much this account absorbs before overflow spills to the next stop. Leave the last stop uncapped as a catch-all." />
                <input
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="number"
                  step="0.01"
                  placeholder="no cap"
                  value={stop.maxBalance ?? ""}
                  onChange={(e) => updateSplitStop(stop.id, { maxBalance: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1">
                Cap grows
                <input
                  className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="number"
                  step="0.001"
                  placeholder="inflation"
                  value={stop.maxBalanceGrowthRatePct ?? ""}
                  onChange={(e) => updateSplitStop(stop.id, { maxBalanceGrowthRatePct: e.target.value === "" ? null : Number(e.target.value) })}
                />
                /yr
              </label>
            </div>
          </div>
        ))}
        <AddAccountSelect
          options={availableAccounts(new Set([...splitIds, ...(extraSavingsId ? [extraSavingsId] : [])]))}
          onAdd={addSplitStop}
          placeholder="+ Add split target"
        />
      </section>

      {/* Drain order */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
          When I&rsquo;m short, drain in this order
          <InfoTooltip text="Each source can have a Start/End date -- leave either blank for 'always'. The same account can be added more than once with different windows for a phased drawdown." />
        </h3>
        <label className="flex items-center gap-2 text-xs text-dim">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={moneyFlow.drainSplitMode === "fixed_split"}
            onChange={(e) => setDrainSplitMode(e.target.checked ? "fixed_split" : "priority_fill")}
          />
          Split by fixed percentages instead of draining one at a time
        </label>
        {moneyFlow.drainOrder.length === 0 && <p className="text-xs text-dim">No drain sources configured yet.</p>}
        {moneyFlow.drainOrder.map((stop, i) => (
          <div key={stop.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button type="button" disabled={i === 0} onClick={() => moveDrainSource(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
                <button type="button" disabled={i === moneyFlow.drainOrder.length - 1} onClick={() => moveDrainSource(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
              </div>
              <span className="flex-1 truncate text-sm">{i + 1}. {accountName(stop.accountId)}</span>
              <button type="button" onClick={() => removeDrainSource(stop.id)} className="text-xs text-negative hover:underline">
                Remove
              </button>
            </div>
            <div className="ml-6 flex flex-wrap items-center gap-3 text-xs text-dim">
              <label className="flex items-center gap-1">
                Start
                <input
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="date"
                  value={stop.startDate ?? ""}
                  onChange={(e) => updateDrainStop(stop.id, { startDate: e.target.value === "" ? null : e.target.value })}
                />
              </label>
              <label className="flex items-center gap-1">
                End
                <input
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="date"
                  value={stop.endDate ?? ""}
                  onChange={(e) => updateDrainStop(stop.id, { endDate: e.target.value === "" ? null : e.target.value })}
                />
              </label>
              <label className="flex items-center gap-1">
                Keep at least $
                <InfoTooltip text="Today's dollars, grown with inflation. Stops this source draining below that floor -- once hit, the remaining shortfall spills to the next active source." />
                <input
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="number"
                  step="0.01"
                  placeholder="0"
                  value={stop.minBalance ?? ""}
                  onChange={(e) => updateDrainStop(stop.id, { minBalance: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </label>
              {moneyFlow.drainSplitMode === "fixed_split" && (
                <label className="flex items-center gap-1">
                  Share
                  <input
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={stop.splitPct ?? 0}
                    onChange={(e) => updateDrainStop(stop.id, { splitPct: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>
          </div>
        ))}
        <AddAccountSelect
          options={availableAccounts(extraSavingsId ? new Set([extraSavingsId]) : new Set())}
          onAdd={addDrainSource}
          placeholder="+ Add drain source"
        />
        {moneyFlow.drainSplitMode === "fixed_split" && (
          <div className={`text-xs ${Math.abs(drainSplitTotal - 1) < 0.001 ? "text-dim" : "text-negative"}`}>
            Total allocated: {(drainSplitTotal * 100).toFixed(0)}%
            {Math.abs(drainSplitTotal - 1) >= 0.001 &&
              " (shares are a target, not a hard cap -- an underfunded share tops up from the next active source)"}
          </div>
        )}
      </section>
    </div>
  );
}

function AddAccountSelect({
  options,
  onAdd,
  placeholder,
}: {
  options: Account[];
  onAdd: (accountId: string) => void;
  placeholder: string;
}) {
  if (options.length === 0) return null;
  return (
    <select
      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-dim"
      value=""
      onChange={(e) => {
        onAdd(e.target.value);
        e.target.value = "";
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
