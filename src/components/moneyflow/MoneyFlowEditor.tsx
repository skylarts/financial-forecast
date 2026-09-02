"use client";

import { useState } from "react";
import { nanoid } from "nanoid";
import type { Account, FlowLimitPeriod, ForecastSettings, MoneyFlow } from "@/domain";
import { forecastSettingsSchema } from "@/domain";
import { ErrorBanner, InfoTooltip, MoneyInput, PercentInput } from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";

/**
 * Cash-flow routing, edited from one place instead of scattered per-account
 * fields. There's no user-configurable "spending account" here anymore --
 * Extra Savings (see the Accounts tab; it can't be deleted) is the one
 * mandatory hub: income deposits there, expenses pay from there, it captures
 * 100% of net income-minus-expenses every month with a floor hardcoded at
 * $0. The two lists below decide what happens with that money: `splitOrder`
 * is where surplus goes and `drainOrder` is what covers a shortfall --
 * both use the same cascading model (each stop a flat $ amount or a % of
 * what's left after the stops above it).
 */
export function MoneyFlowEditor({ accounts, settings }: { accounts: Account[]; settings: ForecastSettings }) {
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const moneyFlow = settings.moneyFlow;
  const extraSavingsId = accounts.find((a) => a.isExtraSavings)?.id;

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "(deleted account)";
  // Only asset accounts can hold routed surplus or fund a shortfall, and a
  // house can't absorb deposits or be sold off piecemeal -- offering
  // liabilities/real estate here used to silently corrupt the projection.
  const availableAccounts = (excludeIds: Set<string>) =>
    accounts.filter((a) => !excludeIds.has(a.id) && a.category === "asset" && a.class !== "real_estate");

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
        {
          id: nanoid(),
          accountId,
          kind: "percent_of_remainder",
          amount: null,
          pct: 1,
          maxBalance: null,
          maxBalanceGrowthRatePct: null,
          startDate: null,
          endDate: null,
        },
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
        {
          id: nanoid(),
          accountId,
          kind: "percent_of_remainder",
          amount: null,
          pct: 1,
          minBalance: null,
          minBalanceGrowthRatePct: null,
          startDate: null,
          endDate: null,
        },
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

  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner message={error} />

      {/* Extra Savings split */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
          When there&rsquo;s extra cash, split it
          <InfoTooltip text="Order is priority -- the first stop is offered first. Each stop is a flat dollar amount or a percentage of what's left after the stops above it (cascading, not a share of the total). Whatever the list doesn't claim stays in Extra Savings. A stop can also have a per-period Limit (how much it may add) and a Start/End date -- leave either blank for 'always'. An account's balance cap lives on the account itself, over on the Accounts tab." />
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
                  className={`rounded px-2 py-0.5 ${stop.kind === "flat" ? "bg-pri text-pri-fg" : "text-dim"}`}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => updateSplitStop(stop.id, { kind: "percent_of_remainder" })}
                  className={`rounded px-2 py-0.5 ${stop.kind === "percent_of_remainder" ? "bg-pri text-pri-fg" : "text-dim"}`}
                >
                  %
                </button>
              </div>
              {stop.kind === "flat" ? (
                <label className="flex items-center gap-1">
                  Amount
                  <span className="w-28">
                    <MoneyInput
                      placeholder="0"
                      defaultValue={stop.amount == null ? "" : moneyToStr(stop.amount)}
                      onBlur={(e) => updateSplitStop(stop.id, { amount: moneyStrToNumber(e.target.value) })}
                    />
                  </span>
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
              <FlowLimitFields
                label="Limit"
                tooltip="The most this stop may add to the account per period, resetting each period -- e.g. $7,000/year for an IRA's contribution room. Anything over it spills to the next stop. Separate from the account's own cap: this bounds how much goes IN, the cap bounds what it may HOLD."
                stop={stop}
                onChange={(patch) => updateSplitStop(stop.id, patch)}
              />
              <BalanceBoundNote account={accounts.find((a) => a.id === stop.accountId)} kind="ceiling" />
              <ActiveWindowFields
                startDate={stop.startDate ?? ""}
                endDate={stop.endDate ?? ""}
                onChange={(patch) => updateSplitStop(stop.id, patch)}
              />
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
          <InfoTooltip text="Order is priority -- the first stop is offered first. Each stop is a flat dollar amount or a percentage of what's left after the stops above it (cascading, not a share of the total shortfall). A stop can also have a per-period Max draw (how fast it may drain) and a Start/End date -- leave either blank for 'always'. The same account can be added more than once with different windows for a phased drawdown. An account's balance floor lives on the account itself, over on the Accounts tab." />
        </h3>
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
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => updateDrainStop(stop.id, { kind: "flat" })}
                  className={`rounded px-2 py-0.5 ${stop.kind === "flat" ? "bg-pri text-pri-fg" : "text-dim"}`}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => updateDrainStop(stop.id, { kind: "percent_of_remainder" })}
                  className={`rounded px-2 py-0.5 ${stop.kind === "percent_of_remainder" ? "bg-pri text-pri-fg" : "text-dim"}`}
                >
                  %
                </button>
              </div>
              {stop.kind === "flat" ? (
                <label className="flex items-center gap-1">
                  Amount
                  <span className="w-28">
                    <MoneyInput
                      placeholder="0"
                      defaultValue={stop.amount == null ? "" : moneyToStr(stop.amount)}
                      onBlur={(e) => updateDrainStop(stop.id, { amount: moneyStrToNumber(e.target.value) })}
                    />
                  </span>
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
                      updateDrainStop(stop.id, { pct: e.target.value === "" ? null : Number(e.target.value) / 100 })
                    }
                  />
                  % of remainder
                </label>
              )}
              <FlowLimitFields
                label="Max draw"
                tooltip="The most this source may send per period, resetting each period -- e.g. $40,000/year to keep realized gains inside a tax bracket. Once it's used up, the rest of the shortfall spills to the next stop. Separate from the account's floor: this bounds how FAST it drains, the floor bounds how far DOWN it may go."
                stop={stop}
                onChange={(patch) => updateDrainStop(stop.id, patch)}
              />
              <BalanceBoundNote account={accounts.find((a) => a.id === stop.accountId)} kind="floor" />
              <ActiveWindowFields
                startDate={stop.startDate ?? ""}
                endDate={stop.endDate ?? ""}
                onChange={(patch) => updateDrainStop(stop.id, patch)}
              />
            </div>
          </div>
        ))}
        <AddAccountSelect
          options={availableAccounts(extraSavingsId ? new Set([extraSavingsId]) : new Set())}
          onAdd={addDrainSource}
          placeholder="+ Add drain source"
        />
      </section>
    </div>
  );
}

/**
 * The rate-limit controls shared by both lists: how much may move through this
 * stop per period. Distinct from the account's own balance ceiling/floor,
 * which is edited on the account and shown here only as context -- a limit
 * bounds the FLOW, a bound the resulting BALANCE, and both apply.
 */
/**
 * The window a routing stop is active for.
 *
 * Start and End are one setting, so they share a row. Wrapping them
 * independently put them on separate lines, and because the inline labels are
 * different widths ("Start" is wider than "End") the two date boxes did not
 * even line up with each other -- they read as two unrelated fields rather
 * than the two ends of one range. On a phone the labels move above the boxes,
 * which is what actually makes the boxes align.
 */
function ActiveWindowFields({
  startDate,
  endDate,
  onChange,
}: {
  startDate: string;
  endDate: string;
  onChange: (patch: { startDate?: string | null; endDate?: string | null }) => void;
}) {
  const box =
    "w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground sm:w-auto";
  const blank = (value: string) => (value === "" ? null : value);
  return (
    <div className="grid w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
      <label className="min-w-0 sm:flex sm:items-center sm:gap-1">
        <span className="mb-0.5 block sm:mb-0">Start</span>
        <input
          className={box}
          type="date"
          value={startDate}
          onChange={(e) => onChange({ startDate: blank(e.target.value) })}
        />
      </label>
      <label className="min-w-0 sm:flex sm:items-center sm:gap-1">
        <span className="mb-0.5 block sm:mb-0">End</span>
        <input
          className={box}
          type="date"
          value={endDate}
          onChange={(e) => onChange({ endDate: blank(e.target.value) })}
        />
      </label>
    </div>
  );
}

function FlowLimitFields({
  label,
  tooltip,
  stop,
  onChange,
}: {
  label: string;
  tooltip: string;
  stop: { limitAmount?: number | null; limitPeriod?: FlowLimitPeriod; limitGrowthRatePct?: number | null };
  onChange: (patch: { limitAmount?: number | null; limitPeriod?: FlowLimitPeriod; limitGrowthRatePct?: number | null }) => void;
}) {
  return (
    <>
      <label className="flex items-center gap-1">
        {label}
        <InfoTooltip text={tooltip} />
        <span className="w-28">
          <MoneyInput
            placeholder="no limit"
            defaultValue={stop.limitAmount == null ? "" : moneyToStr(stop.limitAmount)}
            onBlur={(e) => onChange({ limitAmount: moneyStrToNumber(e.target.value) })}
          />
        </span>
      </label>
      {/* Only meaningful once a limit exists -- hidden otherwise so an
          unlimited stop stays a single empty box rather than three controls. */}
      {stop.limitAmount != null && (
        <>
          <label className="flex items-center gap-1">
            per
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={stop.limitPeriod ?? "annual"}
              onChange={(e) => onChange({ limitPeriod: e.target.value as FlowLimitPeriod })}
            >
              <option value="monthly">month</option>
              <option value="quarterly">quarter</option>
              <option value="annual">year</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            Limit grows
            <span className="w-24">
              <PercentInput
                placeholder="inflation"
                defaultValue={fractionToPercentStr(stop.limitGrowthRatePct ?? null)}
                onBlur={(e) => onChange({ limitGrowthRatePct: percentStrToFraction(e.target.value) })}
              />
            </span>
            /yr
          </label>
        </>
      )}
    </>
  );
}

/**
 * Read-only reminder of the target/source account's balance bound, so the
 * Routing tab still tells you the whole story after the bound moved to the
 * account form. Renders nothing when the account has no bound set.
 */
function BalanceBoundNote({ account, kind }: { account: Account | undefined; kind: "ceiling" | "floor" }) {
  const value = kind === "ceiling" ? account?.balanceCeiling : account?.balanceFloor;
  if (value == null) return null;
  return (
    <span className="italic">
      {kind === "ceiling" ? "Cap" : "Floor"} {moneyToStr(value)} (set on the account)
    </span>
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
