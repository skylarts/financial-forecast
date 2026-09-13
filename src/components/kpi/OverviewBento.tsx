"use client";

import { useMemo } from "react";
import type { Account, ISODate, Person, ProjectionResult, PeriodSnapshot, ScenarioEvent } from "@/domain";
import { retirementsInOrder } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { ACCOUNT_CLASS_LABELS, buildAccountColors, displayAccounts, groupAccountsByClass } from "@/lib/accountColors";
import { ageOn, yearOf } from "@/engine/dateMath";
import { firstShortfallYear, spendingCoveredYears } from "@/engine/planHealth";
import { useUiStore } from "@/store/useUiStore";

/**
 * The Overview dashboard: four numbers that answer "does the plan hold, and
 * what does it come to", the chart, and today's account list. Net worth
 * today is the headline; beside it sit the two moments that matter
 * (retirement, the end of the plan) and whether the money lasts.
 *
 * Explicit grid-template-areas rather than per-tile column spans — with spans,
 * a tile whose content is shorter than its neighbours reflows into a ragged
 * row and the account list collapses.
 */

/** Today's balance for an account: what's on the books right now, exactly as
 *  entered. Accounts that don't exist yet (a home a buy_home event creates in
 *  2033) carry their future value in startingBalance, so they're zero today.
 *  Liability balances are stored as positive magnitudes -- flipped here so
 *  debts read as negative. */
function balanceToday(account: Account, today: string): number {
  if (account.startDate && account.startDate > today) return 0;
  return (account.category === "liability" ? -1 : 1) * account.startingBalance;
}

/** Deflate a flow (growth, deposits) to today's dollars when in real mode. */
function deflateFlow(value: number, year: PeriodSnapshot, mode: DollarMode): number {
  return mode === "real" ? value / year.flowInflationDeflator : value;
}

function Tile({ area, children, className = "" }: { area: string; children: React.ReactNode; className?: string }) {
  return (
    <section style={{ gridArea: area }} className={`joy-lift rounded-xl border border-border bg-panel ${className}`}>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-dim">{children}</span>;
}

/** A compare delta, colored by whether the change is an improvement. */
function Delta({ value, base, vs, invert = false }: { value: number | null; base: number | null; vs: string; invert?: boolean }) {
  if (value === null || base === null) return null;
  const d = value - base;
  if (Math.abs(d) < 0.5) return <span className="font-sans text-[11.5px] text-dim-2">same as {vs}</span>;
  const good = invert ? d < 0 : d > 0;
  return (
    <span className={`font-mono text-[11.5px] font-semibold ${good ? "text-positive" : "text-negative"}`}>
      {d > 0 ? "+" : "−"}
      {formatMoney(Math.abs(d))} <span className="font-sans font-normal text-dim-2">vs {vs}</span>
    </span>
  );
}

export interface CompareOverview {
  name: string;
  projection: ProjectionResult;
}

export function OverviewBento({
  projection,
  years,
  accounts: allAccounts,
  dollarMode,
  planStartDate,
  people,
  compare = null,
  chart,
}: {
  projection: ProjectionResult;
  /** Years already narrowed to the selected range (the chart's window). */
  years: PeriodSnapshot[];
  accounts: Account[];
  dollarMode: DollarMode;
  /** Resolved plan start: scenario.settings.startDate ?? todayISO(). */
  planStartDate: ISODate;
  people: Person[];
  compare?: CompareOverview | null;
  chart: React.ReactNode;
}) {
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const real = dollarMode === "real";
  const nw = (y: PeriodSnapshot | undefined) => (y ? (real ? y.netWorthReal : y.netWorthNominal) : null);

  const firstYear = years[0];
  const planStartYear = yearOf(planStartDate);
  const lastPlanYear = projection.years[projection.years.length - 1];

  // The first retirement in the plan: which year, whose, at what age.
  const retire = useMemo(() => {
    const first = retirementsInOrder(people)[0];
    if (!first) return null;
    return { year: yearOf(first.date), name: first.person.name, age: ageOn(first.person.birthDate, first.date) };
  }, [people]);
  const pastRetirement = retire !== null && planStartYear > retire.year;

  const atRetirement = retire && !pastRetirement ? nw(projection.years.find((y) => y.year === retire.year)) : null;
  const cmpAtRetirement = compare && retire && !pastRetirement ? nw(compare.projection.years.find((y) => y.year === retire.year)) : null;
  const atEnd = nw(lastPlanYear);
  const cmpAtEnd = compare ? nw(compare.projection.years.find((y) => y.year === lastPlanYear?.year)) : null;

  // Past retirement the question is no longer "what will I have when I stop
  // working" but "how long does what I have cover what I spend".
  const covered = pastRetirement ? spendingCoveredYears(projection, planStartYear) : null;
  const cmpCovered = pastRetirement && compare ? spendingCoveredYears(compare.projection, planStartYear) : null;

  const shortfallYear = firstShortfallYear(projection);
  const cmpShortfallYear = compare ? firstShortfallYear(compare.projection) : null;

  // Growth across every asset except cash, paired with deposits into those
  // same accounts, for the first year of the selected range. Cash is left out
  // of both sides: the spending hub's "deposits" are paychecks and drains,
  // not savings. A home's appreciation counts -- it is asset growth, and the
  // tile says so.
  const { assetGrowth, assetDeposits } = useMemo(() => {
    if (!firstYear) return { assetGrowth: 0, assetDeposits: 0 };
    const byId = new Map(allAccounts.map((a) => [a.id, a]));
    let growth = 0;
    let deposits = 0;
    for (const r of firstYear.rollforwards) {
      const acct = byId.get(r.accountId);
      if (!acct || acct.isExcluded || acct.category !== "asset" || acct.class === "cash") continue;
      growth += r.growth;
      deposits += r.deposits;
    }
    return { assetGrowth: deflateFlow(growth, firstYear, dollarMode), assetDeposits: deflateFlow(deposits, firstYear, dollarMode) };
  }, [firstYear, allAccounts, dollarMode]);
  const cmpAssetGrowth = useMemo(() => {
    if (!compare || !firstYear) return null;
    const y = compare.projection.years.find((s) => s.year === firstYear.year);
    if (!y) return null;
    const byId = new Map(compare.projection.accounts.map((a) => [a.id, a]));
    let growth = 0;
    for (const r of y.rollforwards) {
      const acct = byId.get(r.accountId);
      if (!acct || acct.isExcluded || acct.category !== "asset" || acct.class === "cash") continue;
      growth += r.growth;
    }
    return deflateFlow(growth, y, dollarMode);
  }, [compare, firstYear, dollarMode]);

  const accounts = useMemo(() => displayAccounts(allAccounts), [allAccounts]);
  const accountColors = useMemo(() => buildAccountColors(accounts, isJoy), [accounts, isJoy]);

  // Balances as they stand TODAY, not a projected figure -- this list reads
  // as "what I have right now", so it agrees with the Accounts tab and with
  // what was typed in. Today's balances are already in today's dollars, so
  // they're the same in both modes and don't move with the selected range.
  const { rows, rowById, classSections } = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const built = accounts.map((a) => ({ id: a.id, name: a.name, color: accountColors.get(a.id), value: balanceToday(a, today) }));
    const byId = new Map(built.map((r) => [r.id, r]));
    return {
      rows: built,
      rowById: byId,
      classSections: groupAccountsByClass(accounts)
        .map((g) => ({
          cls: g.cls,
          label: ACCOUNT_CLASS_LABELS[g.cls],
          accounts: g.accounts.filter((a) => (byId.get(a.id)?.value ?? 0) !== 0),
        }))
        .filter((g) => g.accounts.length > 0),
    };
  }, [accounts, accountColors]);
  const netWorthToday = rows.reduce((s, r) => s + r.value, 0);
  const cmpNetWorthToday = useMemo(() => {
    if (!compare) return null;
    const today = new Date().toISOString().slice(0, 10);
    return displayAccounts(compare.projection.accounts).reduce((s, a) => s + balanceToday(a, today), 0);
  }, [compare]);

  const holdsLabel = shortfallYear === null ? "End of plan" : `Runs short in ${shortfallYear}`;

  // Grid areas live in globals.css (.bento) rather than as Tailwind arbitrary
  // values -- the underscore-escaped area syntax is unreadable and fails
  // silently when it's wrong.
  return (
    <div className="bento">
      {/* ---- Hero: the headline number and the two moments that matter ---- */}
      <Tile area="hero" className="flex flex-col justify-between gap-4 bg-gradient-to-br from-panel-2 to-panel p-5">
        <div>
          <Label>Net worth today</Label>
          <div className="mt-1.5 font-mono text-[42px] font-bold leading-none tracking-tight tabular-nums">{formatMoney(netWorthToday)}</div>
          <div className="mt-2 text-[11.5px] text-dim-2">
            What you entered, as of today
            {compare && (
              <>
                {" · "}
                <Delta value={netWorthToday} base={cmpNetWorthToday} vs={compare.name} />
              </>
            )}
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-3.5">
          {pastRetirement ? (
            <div>
              <dt>
                <Label>Spending covered</Label>
              </dt>
              <dd className="mt-1 font-mono text-base font-semibold tabular-nums text-gold">
                {covered === null ? "—" : `${covered >= 100 ? "100+" : covered.toFixed(covered < 10 ? 1 : 0)} years`}
              </dd>
              <dd className="mt-0.5 text-[11px] text-dim-2">
                of this year&rsquo;s spending, from investable accounts
                {compare && cmpCovered !== null && covered !== null && (
                  <span className={`ml-1 font-mono ${covered - cmpCovered >= 0 ? "text-positive" : "text-negative"}`}>
                    {covered - cmpCovered >= 0 ? "+" : "−"}
                    {Math.abs(covered - cmpCovered).toFixed(1)} vs {compare.name}
                  </span>
                )}
              </dd>
            </div>
          ) : (
            <div>
              <dt>
                <Label>{retire ? `At retirement · ${retire.year}` : "At retirement"}</Label>
              </dt>
              <dd className="mt-1 font-mono text-base font-semibold tabular-nums text-gold">{atRetirement !== null ? formatMoney(atRetirement) : "—"}</dd>
              <dd className="mt-0.5 text-[11px] text-dim-2">
                {retire ? `${retire.name ?? "First retirement"}${retire.age !== null ? ` at ${retire.age}` : ""}, end of ${retire.year}` : "Add a Retire event"}
                {compare && (
                  <>
                    {" · "}
                    <Delta value={atRetirement} base={cmpAtRetirement} vs={compare.name} />
                  </>
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>
              <Label>At end of plan{lastPlanYear ? ` · ${lastPlanYear.year}` : ""}</Label>
            </dt>
            <dd className="mt-1 font-mono text-base font-semibold tabular-nums">{atEnd !== null ? formatMoney(atEnd) : "—"}</dd>
            <dd className="mt-0.5 text-[11px] text-dim-2">
              {real ? "Today’s dollars" : "Future dollars"}
              {compare && (
                <>
                  {" · "}
                  <Delta value={atEnd} base={cmpAtEnd} vs={compare.name} />
                </>
              )}
            </dd>
          </div>
        </dl>
      </Tile>

      {/* ---- Does the plan hold? ---- */}
      <Tile area="k1" className="p-4">
        <Label>Holds through</Label>
        <div className={`mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums ${shortfallYear === null ? "text-positive" : "text-negative"}`}>
          {holdsLabel}
        </div>
        <div className="mt-1.5 text-[11.5px] text-dim-2">
          {shortfallYear === null ? "Every year's spending is covered." : "The first year the withdrawal routing cannot cover spending."}
          {compare && cmpShortfallYear !== shortfallYear && (
            <span className="ml-1">
              {compare.name}: {cmpShortfallYear === null ? "end of plan" : `runs short in ${cmpShortfallYear}`}
            </span>
          )}
        </div>
      </Tile>

      {/* ---- What the assets earned in the range's first year ---- */}
      <Tile area="k2" className="p-4">
        <Label>Asset growth · {firstYear?.year ?? ""}</Label>
        <div className={`mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums ${assetGrowth >= 0 ? "text-positive" : "text-negative"}`}>
          {formatMoney(assetGrowth)}
        </div>
        <div className="mt-1.5 text-[11.5px] text-dim-2">
          vs {formatMoney(assetDeposits)} contributed · includes home value
          {compare && (
            <>
              {" · "}
              <Delta value={assetGrowth} base={cmpAssetGrowth} vs={compare.name} />
            </>
          )}
        </div>
      </Tile>

      {/* ---- Chart. NetWorthChart brings its own panel chrome, so it is
              placed directly into the grid area rather than wrapped. ---- */}
      <div style={{ gridArea: "chart" }} className="min-w-0">
        {chart}
      </div>

      {/* ---- Account snapshot, colored to match the chart's series ---- */}
      <Tile area="list" className="flex flex-col overflow-hidden py-4">
        <div className="px-4 pb-3">
          <Label>Accounts · today</Label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {classSections.map((g) => {
            const subtotal = g.accounts.reduce((s, a) => s + (rowById.get(a.id)?.value ?? 0), 0);
            return (
              <li key={g.cls} className="border-b border-border-soft last:border-b-0">
                <div className="flex items-center justify-between gap-3 bg-panel-2/60 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">
                  <span>{g.label}</span>
                  <span className={`font-mono tabular-nums ${subtotal < 0 ? "text-negative" : ""}`}>{formatMoney(subtotal)}</span>
                </div>
                <ul>
                  {g.accounts.map((a) => {
                    const r = rowById.get(a.id);
                    if (!r) return null;
                    return (
                      <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[12.5px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <i aria-hidden className="block h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} />
                          <span className="truncate">{r.name}</span>
                        </span>
                        <span className={`shrink-0 font-mono tabular-nums ${r.value < 0 ? "text-negative" : "text-dim"}`}>{formatMoney(r.value)}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 flex items-center justify-between border-t border-border bg-panel-2 px-4 py-2.5 text-[12.5px] font-bold">
          <span>Net worth</span>
          <span className="font-mono tabular-nums">{formatMoney(netWorthToday)}</span>
        </div>
      </Tile>
    </div>
  );
}
