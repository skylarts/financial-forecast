"use client";

import { useState } from "react";
import { nanoid } from "nanoid";
import type { Account, FlowLimitPeriod, ForecastSettings, LedgerEvent, MoneyFlow, WithdrawalStrategy } from "@/domain";
import { forecastSettingsSchema } from "@/domain";
import { ErrorBanner, InfoTooltip, MoneyInput, PercentInput } from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";
import {
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  TIER_LABELS,
  accountsInStrategyOrder,
  drainTierOf,
  materializeDrainOrder,
  unreachableAccounts,
} from "@/engine/strategy";

const PRESET_KEYS: WithdrawalStrategy[] = ["conventional", "tax_deferred_first", "pro_rata", "custom"];

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
export function MoneyFlowEditor({ accounts, settings, ledger = [] }: { accounts: Account[]; settings: ForecastSettings; ledger?: LedgerEvent[] }) {
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  // Which stops have their limit and date-window controls unfolded.
  const [openStops, setOpenStops] = useState<Set<string>>(new Set());
  const toggleStop = (id: string) =>
    setOpenStops((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // A worked example from the projection itself: the first year the rule
  // actually moved money, and where it went.
  const example = (kind: "surplus_route" | "deficit_withdrawal") => {
    const entries = ledger.filter((e) => e.kind === kind);
    if (entries.length === 0) return null;
    const year = Math.min(...entries.map((e) => Number(e.date.slice(0, 4))));
    const byAccount = new Map<string, number>();
    for (const e of entries) {
      if (Number(e.date.slice(0, 4)) !== year) continue;
      const key = kind === "surplus_route" ? (e.toAccountId ?? e.accountId) : e.accountId;
      byAccount.set(key, (byAccount.get(key) ?? 0) + e.amount);
    }
    const total = [...byAccount.values()].reduce((a, b) => a + b, 0);
    const parts = [...byAccount.entries()].sort((a, b) => b[1] - a[1]).map(([id, amt]) => `${accountName(id)} $${moneyToStr(Math.round(amt))}`);
    return { year, total: moneyToStr(Math.round(total)), parts };
  };
  const moneyFlow = settings.moneyFlow;
  const extraSavingsId = accounts.find((a) => a.isExtraSavings)?.id;

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "(deleted account)";
  // Only asset accounts can hold routed surplus or fund a shortfall, and a
  // house can't absorb deposits or be sold off piecemeal -- offering
  // liabilities/real estate here used to silently corrupt the projection.
  const availableAccounts = (excludeIds: Set<string>) =>
    accounts.filter((a) => !excludeIds.has(a.id) && a.category === "asset" && a.class !== "real_estate");

  // Patch against the store's current settings rather than the prop, so an
  // edit here can never write back a stale copy of something changed elsewhere.
  const saveSettings = (patch: Partial<ForecastSettings>) => {
    const current = usePlanStore.getState().activeScenario().settings;
    const result = forecastSettingsSchema.safeParse({ ...current, ...patch });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid money flow configuration.");
      return;
    }
    setError(null);
    updateSettings(result.data);
  };
  const save = (next: MoneyFlow) => saveSettings({ moneyFlow: next });

  // --- Withdrawal strategy (what covers a shortfall) ---
  const strategy = settings.withdrawalStrategy;
  const presetOrder = strategy === "custom" ? [] : accountsInStrategyOrder(strategy, accounts);
  const neverDrawn = accounts.filter((a) => a.category === "asset" && !a.isExtraSavings && !a.isExcluded && drainTierOf(a) === null);
  const unreachable = strategy === "custom" ? unreachableAccounts(moneyFlow.drainOrder, accounts) : [];
  const chooseStrategy = (next: WithdrawalStrategy) => {
    if (next === strategy) return;
    if (next === "custom") {
      // Start the editor from the order the current preset was using.
      const seed = strategy === "custom" ? moneyFlow.drainOrder : materializeDrainOrder(strategy, accounts);
      saveSettings({ withdrawalStrategy: "custom", moneyFlow: { ...moneyFlow, drainOrder: seed } });
      return;
    }
    saveSettings({ withdrawalStrategy: next });
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
        <WorkedExample kind="surplus_route" example={example("surplus_route")} />
        {moneyFlow.splitOrder.length === 0 && <p className="text-xs text-dim">No surplus targets configured yet: extra cash stays in Extra Savings.</p>}
        {moneyFlow.splitOrder.map((stop, i) => (
          <div key={stop.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button type="button" disabled={i === 0} onClick={() => moveSplitStop(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
                <button type="button" disabled={i === moneyFlow.splitOrder.length - 1} onClick={() => moveSplitStop(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
              </div>
              <span className="flex-1 truncate text-sm">
                {i + 1}. {accountName(stop.accountId)}
                {isInert(stop) && <span className="ml-2 text-[11px] text-negative">receives nothing</span>}
              </span>
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
                  <ShareInput value={stop.pct} onCommit={(pct) => updateSplitStop(stop.id, { pct })} />
                  % of remainder
                </label>
              )}
              <BalanceBoundNote account={accounts.find((a) => a.id === stop.accountId)} kind="ceiling" />
              <MoreToggle open={openStops.has(stop.id)} onToggle={() => toggleStop(stop.id)} stop={stop} />
            </div>
            {openStops.has(stop.id) && (
              <div className="ml-6 flex flex-wrap items-center gap-3 border-l border-border pl-3 text-xs text-dim">
                <FlowLimitFields
                  label="Limit"
                  tooltip="The most this stop may add to the account per period, resetting each period -- e.g. $7,000/year for an IRA's contribution room. Anything over it spills to the next stop. Separate from the account's own cap: this bounds how much goes IN, the cap bounds what it may HOLD."
                  stop={stop}
                  onChange={(patch) => updateSplitStop(stop.id, patch)}
                />
                <ActiveWindowFields
                  startDate={stop.startDate ?? ""}
                  endDate={stop.endDate ?? ""}
                  onChange={(patch) => updateSplitStop(stop.id, patch)}
                />
              </div>
            )}
          </div>
        ))}
        <AddAccountSelect
          options={availableAccounts(new Set([...splitIds, ...(extraSavingsId ? [extraSavingsId] : [])]))}
          onAdd={addSplitStop}
          placeholder="+ Add split target"
        />
      </section>

      {/* Withdrawal strategy: what covers a shortfall */}
      <section className="flex flex-col gap-3">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
          When I&rsquo;m short, draw from
          <InfoTooltip text="Which accounts cover a shortfall in Extra Savings, and in what order. A preset derives the order from your accounts (so a new account is never left out); Custom lets you set every stop, share, limit and date window yourself. This order is the biggest lever on your lifetime tax bill." />
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {PRESET_KEYS.map((key) => {
            const active = key === strategy;
            return (
              <button
                key={key}
                type="button"
                onClick={() => chooseStrategy(key)}
                aria-pressed={active}
                className={`rounded-md border p-2.5 text-left transition-colors ${
                  active ? "border-accent bg-accent/10" : "border-border hover:border-accent/60"
                }`}
              >
                <div className="text-sm font-medium">{STRATEGY_LABELS[key]}</div>
                <div className="mt-0.5 text-[11px] text-dim">{STRATEGY_DESCRIPTIONS[key]}</div>
              </button>
            );
          })}
        </div>
        <WorkedExample kind="deficit_withdrawal" example={example("deficit_withdrawal")} />
        {strategy !== "custom" ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-2.5 text-xs">
            <div className="font-semibold text-dim">The order the plan will use</div>
            {presetOrder.length === 0 ? (
              <p className="text-dim">No account can cover a shortfall yet. Add a cash or investment account.</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {presetOrder.map((a, i) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="w-4 text-right font-mono text-dim-2">{i + 1}.</span>
                    <span>{a.name}</span>
                    <span className="text-dim-2">· {TIER_LABELS[drainTierOf(a)!]}</span>
                  </li>
                ))}
              </ol>
            )}
            {strategy === "pro_rata" && presetOrder.length > 0 && (
              <p className="text-dim-2">Cash accounts empty in order; the investment accounts then share each shortfall in proportion to their balances.</p>
            )}
            {neverDrawn.length > 0 && (
              <p className="text-dim-2">
                Never drawn: {neverDrawn.map((a) => a.name).join(", ")}. Homes, other assets, HSAs and 529s are left for their own purpose; use Custom to include one.
              </p>
            )}
            <div>
              <button
                type="button"
                onClick={() => chooseStrategy("custom")}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-dim hover:border-accent hover:text-foreground"
              >
                Customize this order
              </button>
            </div>
          </div>
        ) : (
          <>
            {unreachable.length > 0 && (
              <p className="rounded-md border border-negative/40 bg-negative/10 px-2.5 py-2 text-xs text-negative">
                Never drawn from: {unreachable.map((a) => a.name).join(", ")}. These will not cover a shortfall. Add them below, or pick a preset.
              </p>
            )}
        {moneyFlow.drainOrder.length === 0 && <p className="text-xs text-dim">No drain sources configured yet.</p>}
        {moneyFlow.drainOrder.map((stop, i) => (
          <div key={stop.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button type="button" disabled={i === 0} onClick={() => moveDrainSource(i, -1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▲</button>
                <button type="button" disabled={i === moneyFlow.drainOrder.length - 1} onClick={() => moveDrainSource(i, 1)} className="text-xs text-dim disabled:opacity-30 hover:text-foreground">▼</button>
              </div>
              <span className="flex-1 truncate text-sm">
                {i + 1}. {accountName(stop.accountId)}
                {isInert(stop) && <span className="ml-2 text-[11px] text-negative">covers nothing</span>}
              </span>
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
                  <ShareInput value={stop.pct} onCommit={(pct) => updateDrainStop(stop.id, { pct })} />
                  % of remainder
                </label>
              )}
              <BalanceBoundNote account={accounts.find((a) => a.id === stop.accountId)} kind="floor" />
              <MoreToggle open={openStops.has(stop.id)} onToggle={() => toggleStop(stop.id)} stop={stop} />
            </div>
            {openStops.has(stop.id) && (
              <div className="ml-6 flex flex-wrap items-center gap-3 border-l border-border pl-3 text-xs text-dim">
                <FlowLimitFields
                  label="Max draw"
                  tooltip="The most this source may send per period, resetting each period -- e.g. $40,000/year to keep realized gains inside a tax bracket. Once it's used up, the rest of the shortfall spills to the next stop. Separate from the account's floor: this bounds how FAST it drains, the floor bounds how far DOWN it may go."
                  stop={stop}
                  onChange={(patch) => updateDrainStop(stop.id, patch)}
                />
                <ActiveWindowFields
                  startDate={stop.startDate ?? ""}
                  endDate={stop.endDate ?? ""}
                  onChange={(patch) => updateDrainStop(stop.id, patch)}
                />
              </div>
            )}
          </div>
        ))}
        <AddAccountSelect
          options={availableAccounts(extraSavingsId ? new Set([extraSavingsId]) : new Set())}
          onAdd={addDrainSource}
          placeholder="+ Add drain source"
        />
          </>
        )}
        <label className="flex flex-col gap-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1">
            Cash to keep on hand
            <InfoTooltip text="A buffer in Extra Savings, in today's dollars. Whenever spending draws it down, the order above tops it back up -- so retirement is not run with cash at $0 between bills. Leave blank to draw exactly what each month needs." />
          </span>
          <span className="w-40">
            <MoneyInput
              key={settings.cashBufferTarget ?? "blank"}
              placeholder="none"
              defaultValue={settings.cashBufferTarget == null ? "" : moneyToStr(settings.cashBufferTarget)}
              onBlur={(e) => saveSettings({ cashBufferTarget: moneyStrToNumber(e.target.value) })}
            />
          </span>
        </label>
      </section>
    </div>
  );
}

/** "More" for a stop: the limit and date window, folded away unless set. */
function MoreToggle({
  open,
  onToggle,
  stop,
}: {
  open: boolean;
  onToggle: () => void;
  stop: { limitAmount?: number | null; startDate: string | null; endDate: string | null };
}) {
  const hasDetail = stop.limitAmount != null || !!stop.startDate || !!stop.endDate;
  return (
    <button type="button" onClick={onToggle} className="text-[11px] text-dim hover:text-foreground">
      {open ? "▾ Less" : hasDetail ? "▸ Limit / dates set" : "▸ More"}
    </button>
  );
}

/** One line from the projection showing the rule at work. */
function WorkedExample({
  kind,
  example,
}: {
  kind: "surplus_route" | "deficit_withdrawal";
  example: { year: number; total: string; parts: string[] } | null;
}) {
  if (!example) {
    return (
      <p className="text-[11px] text-dim-2">
        {kind === "surplus_route" ? "The projection never swept a surplus anywhere." : "The projection never had to draw on an account."}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-dim-2">
      {kind === "surplus_route"
        ? `In ${example.year}: $${example.total} of surplus went to ${example.parts.join(", ")}.`
        : `In ${example.year}: $${example.total} was drawn from ${example.parts.join(", ")}.`}
    </p>
  );
}

/** A stop that can never move money: a flat amount left blank, or a zero/blank share. */
function isInert(stop: { kind: "flat" | "percent_of_remainder"; amount: number | null; pct: number | null }): boolean {
  return stop.kind === "flat" ? stop.amount == null || stop.amount <= 0 : stop.pct == null || stop.pct <= 0;
}

/**
 * The "% of remainder" box. Saves when you leave it, not on every keystroke
 * (each save re-runs the projection), and a box cleared to retype goes back
 * to its old value instead of saving a blank share that routes nothing.
 */
function ShareInput({ value, onCommit }: { value: number | null; onCommit: (pct: number) => void }) {
  const shown = value == null ? "" : String(Math.round(value * 100));
  return (
    <input
      key={shown}
      className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
      type="number"
      step="1"
      min="0"
      max="100"
      defaultValue={shown}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const n = Number(raw);
        if (raw === "" || !Number.isFinite(n)) {
          e.target.value = shown;
          return;
        }
        const pct = Math.max(0, Math.min(100, n)) / 100;
        if (pct !== value) onCommit(pct);
      }}
    />
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
