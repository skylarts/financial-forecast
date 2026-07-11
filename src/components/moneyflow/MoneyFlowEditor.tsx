"use client";

import { useState } from "react";
import type { Account, ForecastSettings, MoneyFlow } from "@/domain";
import { forecastSettingsSchema } from "@/domain";
import { ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

/**
 * The "waterfall": two ordered lists replacing the old scattered per-account
 * fields (isSpendingAccount, targetCashBalance, withdrawalPriority,
 * isSurplusTarget, surplusTargetPriority, maxBalance, maxBalanceGrowthRatePct)
 * and the global surplusRoutingRule. Every one of those values still exists --
 * it's just attached to a stop in one of these lists instead of to the
 * account itself, so it's edited from one place instead of hunting through
 * every account's form.
 */
export function MoneyFlowEditor({ accounts, settings }: { accounts: Account[]; settings: ForecastSettings }) {
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const moneyFlow = settings.moneyFlow;

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

  // --- Hubs (spending accounts) ---
  const hubIds = new Set(moneyFlow.hubs.map((h) => h.accountId));
  const addHub = (accountId: string) => {
    if (!accountId) return;
    save({ ...moneyFlow, hubs: [...moneyFlow.hubs, { accountId, bufferAmount: null }] });
  };
  const updateHubBuffer = (accountId: string, bufferAmount: number | null) =>
    save({ ...moneyFlow, hubs: moneyFlow.hubs.map((h) => (h.accountId === accountId ? { ...h, bufferAmount } : h)) });
  const removeHub = (accountId: string) =>
    save({ ...moneyFlow, hubs: moneyFlow.hubs.filter((h) => h.accountId !== accountId) });

  // --- Fill order (surplus targets) ---
  const fillIds = new Set(moneyFlow.fillOrder.map((f) => f.accountId));
  const addFillStop = (accountId: string) => {
    if (!accountId) return;
    save({
      ...moneyFlow,
      fillOrder: [...moneyFlow.fillOrder, { accountId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null }],
    });
  };
  const updateFillStop = (accountId: string, patch: Partial<MoneyFlow["fillOrder"][number]>) =>
    save({
      ...moneyFlow,
      fillOrder: moneyFlow.fillOrder.map((f) => (f.accountId === accountId ? { ...f, ...patch } : f)),
    });
  const removeFillStop = (accountId: string) =>
    save({ ...moneyFlow, fillOrder: moneyFlow.fillOrder.filter((f) => f.accountId !== accountId) });
  const moveFillStop = (index: number, dir: -1 | 1) => {
    const next = [...moneyFlow.fillOrder];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save({ ...moneyFlow, fillOrder: next });
  };
  const setSplitMode = (splitMode: MoneyFlow["splitMode"]) => {
    // Seed an even split across current fill stops the moment the user
    // switches into fixed_split, so it does something sensible immediately
    // instead of defaulting to a broken/empty 0%-everywhere state.
    const fillOrder =
      splitMode === "fixed_split"
        ? moneyFlow.fillOrder.map((f) => ({ ...f, splitPct: f.splitPct ?? 1 / Math.max(1, moneyFlow.fillOrder.length) }))
        : moneyFlow.fillOrder;
    save({ ...moneyFlow, splitMode, fillOrder });
  };
  const splitTotal = moneyFlow.fillOrder.reduce((s, f) => s + (f.splitPct ?? 0), 0);

  // --- Drain order (deficit cascade) ---
  const drainIds = new Set(moneyFlow.drainOrder);
  const addDrainSource = (accountId: string) => {
    if (!accountId) return;
    save({ ...moneyFlow, drainOrder: [...moneyFlow.drainOrder, accountId] });
  };
  const removeDrainSource = (accountId: string) =>
    save({ ...moneyFlow, drainOrder: moneyFlow.drainOrder.filter((id) => id !== accountId) });
  const moveDrainSource = (index: number, dir: -1 | 1) => {
    const next = [...moneyFlow.drainOrder];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save({ ...moneyFlow, drainOrder: next });
  };

  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner message={error} />
      <p className="text-xs text-dim">
        This is where cash-flow routing lives -- which account(s) income deposits into and expenses pay from, where
        extra cash goes when there&rsquo;s a surplus, and what gets drawn down first when there&rsquo;s a shortfall.
        Order is priority: the first stop in a list is filled (or drained) first.
      </p>

      {/* Spending hubs */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">Spending accounts</h3>
        <p className="text-xs text-dim">
          Income deposits here, expenses pay from here. Each keeps its own buffer (today&rsquo;s dollars, grown with
          inflation) before surplus above it gets swept. Usually just one (e.g. checking), but you can add more.
        </p>
        {moneyFlow.hubs.length === 0 && <p className="text-xs text-dim">No spending accounts configured yet.</p>}
        {moneyFlow.hubs.map((hub) => (
          <div key={hub.accountId} className="flex items-center gap-2 rounded-md border border-border p-2">
            <span className="flex-1 truncate text-sm">{accountName(hub.accountId)}</span>
            <label className="flex items-center gap-1 text-xs text-dim">
              Keep $
              <input
                className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                type="number"
                step="0.01"
                placeholder="0"
                value={hub.bufferAmount ?? ""}
                onChange={(e) => updateHubBuffer(hub.accountId, e.target.value === "" ? null : Number(e.target.value))}
              />
            </label>
            <button type="button" onClick={() => removeHub(hub.accountId)} className="text-xs text-negative hover:underline">
              Remove
            </button>
          </div>
        ))}
        <AddAccountSelect options={availableAccounts(hubIds)} onAdd={addHub} placeholder="+ Add spending account" />
      </section>

      {/* Fill order */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">When there&rsquo;s extra cash, fill in this order</h3>
        <label className="flex items-center gap-2 text-xs text-dim">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={moneyFlow.splitMode === "fixed_split"}
            onChange={(e) => setSplitMode(e.target.checked ? "fixed_split" : "priority_fill")}
          />
          Split by fixed percentages instead of filling one at a time
        </label>
        {moneyFlow.fillOrder.length === 0 && <p className="text-xs text-dim">No surplus targets configured yet.</p>}
        {moneyFlow.fillOrder.map((stop, i) => (
          <div key={stop.accountId} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button type="button" disabled={i === 0} onClick={() => moveFillStop(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
                <button type="button" disabled={i === moneyFlow.fillOrder.length - 1} onClick={() => moveFillStop(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
              </div>
              <span className="flex-1 truncate text-sm">{i + 1}. {accountName(stop.accountId)}</span>
              <button type="button" onClick={() => removeFillStop(stop.accountId)} className="text-xs text-negative hover:underline">
                Remove
              </button>
            </div>
            <div className="ml-6 flex flex-wrap items-center gap-3 text-xs text-dim">
              <label className="flex items-center gap-1">
                Cap $
                <input
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  type="number"
                  step="0.01"
                  placeholder="no cap"
                  value={stop.maxBalance ?? ""}
                  onChange={(e) => updateFillStop(stop.accountId, { maxBalance: e.target.value === "" ? null : Number(e.target.value) })}
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
                  onChange={(e) => updateFillStop(stop.accountId, { maxBalanceGrowthRatePct: e.target.value === "" ? null : Number(e.target.value) })}
                />
                /yr
              </label>
              {moneyFlow.splitMode === "fixed_split" && (
                <label className="flex items-center gap-1">
                  Share
                  <input
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={stop.splitPct ?? 0}
                    onChange={(e) => updateFillStop(stop.accountId, { splitPct: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>
          </div>
        ))}
        <AddAccountSelect options={availableAccounts(fillIds)} onAdd={addFillStop} placeholder="+ Add fill target" />
        {moneyFlow.splitMode === "fixed_split" && (
          <div className={`text-xs ${Math.abs(splitTotal - 1) < 0.001 ? "text-dim" : "text-negative"}`}>
            Total allocated: {(splitTotal * 100).toFixed(0)}%
            {Math.abs(splitTotal - 1) >= 0.001 && " (the remainder stays in the spending account)"}
          </div>
        )}
        <p className="text-xs text-dim">
          Cap = how much this account absorbs before overflow spills to the next stop. Leave the last stop uncapped
          as a catch-all, or surplus with nowhere to go simply stays put.
        </p>
      </section>

      {/* Drain order */}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">When I&rsquo;m short, drain in this order</h3>
        {moneyFlow.drainOrder.length === 0 && <p className="text-xs text-dim">No drain sources configured yet.</p>}
        {moneyFlow.drainOrder.map((accountId, i) => (
          <div key={accountId} className="flex items-center gap-2 rounded-md border border-border p-2">
            <div className="flex flex-col">
              <button type="button" disabled={i === 0} onClick={() => moveDrainSource(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
              <button type="button" disabled={i === moneyFlow.drainOrder.length - 1} onClick={() => moveDrainSource(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
            </div>
            <span className="flex-1 truncate text-sm">{i + 1}. {accountName(accountId)}</span>
            <button type="button" onClick={() => removeDrainSource(accountId)} className="text-xs text-negative hover:underline">
              Remove
            </button>
          </div>
        ))}
        <AddAccountSelect options={availableAccounts(drainIds)} onAdd={addDrainSource} placeholder="+ Add drain source" />
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
