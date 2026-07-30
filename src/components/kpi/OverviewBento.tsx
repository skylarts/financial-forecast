"use client";

import { useMemo } from "react";
import type { Account, ProjectionResult, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { buildAccountColors, displayAccounts } from "@/lib/accountColors";
import { useUiStore } from "@/store/useUiStore";

/**
 * The Overview dashboard: an asymmetric grid where tile size encodes
 * importance. Net worth is the headline, so it gets a tile four columns wide
 * with the two retirement facts inline beneath it; the chart and the account
 * snapshot share the lower band.
 *
 * Explicit grid-template-areas rather than per-tile column spans — with spans,
 * a tile whose content is shorter than its neighbours reflows into a ragged
 * row and the account list collapses.
 */

/** Deflate a flow (income, tax, surplus) to today's dollars when in real mode.
 *  Flows use flowInflationDeflator (mid-year), not the year-end balance one. */
function deflateFlow(value: number, year: YearSnapshot, mode: DollarMode): number {
  return mode === "real" ? value / year.flowInflationDeflator : value;
}

function deflateBalance(value: number, year: YearSnapshot, mode: DollarMode): number {
  return mode === "real" ? value / year.inflationDeflator : value;
}

function Tile({
  area,
  children,
  className = "",
}: {
  area: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      style={{ gridArea: area }}
      className={`joy-lift rounded-xl border border-border bg-panel ${className}`}
    >
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-dim">{children}</span>
  );
}

/** A compare delta, colored by whether the change is an improvement. */
function Delta({ text, good, vs }: { text: string; good: boolean; vs: string }) {
  return (
    <span className={`font-mono text-[11.5px] font-semibold ${good ? "text-positive" : "text-negative"}`}>
      {text} <span className="font-sans font-normal text-dim-2">vs {vs}</span>
    </span>
  );
}

export function OverviewBento({
  kpis,
  years,
  accounts: allAccounts,
  dollarMode,
  isFullRange,
  compareKpis = null,
  compareName = null,
  chart,
}: {
  kpis: ProjectionResult["kpis"];
  /** Years already narrowed to the selected range. */
  years: YearSnapshot[];
  accounts: Account[];
  dollarMode: DollarMode;
  isFullRange: boolean;
  compareKpis?: ProjectionResult["kpis"] | null;
  compareName?: string | null;
  chart: React.ReactNode;
}) {
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const real = dollarMode === "real";

  const firstYear = years[0];
  const lastYear = years[years.length - 1];

  const eoy = real ? kpis.netWorthEndOfYear1Real : kpis.netWorthEndOfYear1;
  const atRetirement = real ? kpis.netWorthAtRetirementReal : kpis.netWorthAtRetirement;
  const atEnd = lastYear ? (real ? lastYear.netWorthReal : lastYear.netWorthNominal) : 0;

  const cmpEoy = compareKpis ? (real ? compareKpis.netWorthEndOfYear1Real : compareKpis.netWorthEndOfYear1) : null;
  const cmpRetirementAge = compareKpis?.retirementAge ?? null;

  // First-year cash-flow figures for the two stat tiles. These are "what the
  // plan does right now", which is the number you're usually adjusting.
  //
  // Savings rate rather than federal tax: because income is entered as
  // take-home, the engine only realizes tax on withdrawals/pension/Social
  // Security, so federalTaxTotal is legitimately $0 for every pre-retirement
  // year -- a tile that reads $0 for decades earns none of its space.
  const surplus = firstYear ? deflateFlow(firstYear.cashFlow.operatingCashFlow, firstYear, dollarMode) : 0;
  const income = firstYear ? deflateFlow(firstYear.cashFlow.totalIncome, firstYear, dollarMode) : 0;
  const expenses = firstYear ? deflateFlow(firstYear.cashFlow.totalExpenses, firstYear, dollarMode) : 0;
  // Ratio of undeflated figures -- a rate is scale-free, so deflating both
  // sides would cancel out anyway.
  const savingsRate =
    firstYear && firstYear.cashFlow.totalIncome > 0
      ? (firstYear.cashFlow.operatingCashFlow / firstYear.cashFlow.totalIncome) * 100
      : null;

  const accounts = useMemo(() => displayAccounts(allAccounts), [allAccounts]);
  const accountColors = useMemo(() => buildAccountColors(accounts, isJoy), [accounts, isJoy]);

  const snapshotYear = firstYear;
  const rows = snapshotYear
    ? accounts.map((a) => ({
        id: a.id,
        name: a.name,
        color: accountColors.get(a.id),
        value: deflateBalance(snapshotYear.accountBalances[a.id] ?? 0, snapshotYear, dollarMode),
      }))
    : [];

  // Grid areas live in globals.css (.bento) rather than as Tailwind arbitrary
  // values -- the underscore-escaped area syntax is unreadable and fails
  // silently when it's wrong.
  return (
    <div className="bento">
      {/* ---- Hero: the headline number ---- */}
      <Tile
        area="hero"
        className="flex flex-col justify-between gap-4 bg-gradient-to-br from-panel-2 to-panel p-5"
      >
        <div>
          <Label>Net worth · end of year</Label>
          <div className="mt-1.5 font-mono text-[42px] font-bold leading-none tracking-tight tabular-nums">
            {formatMoney(eoy)}
          </div>
          <div className="mt-2 text-[11.5px] text-dim-2">
            {real ? "Today’s dollars" : "Future dollars"}
            {compareKpis && cmpEoy !== null && (
              <>
                {" · "}
                <Delta
                  text={`${eoy - cmpEoy >= 0 ? "+" : ""}${formatMoney(eoy - cmpEoy)}`}
                  good={eoy - cmpEoy >= 0}
                  vs={compareName ?? "compare"}
                />
              </>
            )}
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-3.5">
          <div>
            <dt>
              <Label>At retirement</Label>
            </dt>
            <dd className="mt-1 font-mono text-base font-semibold tabular-nums text-gold">
              {atRetirement !== null ? formatMoney(atRetirement) : "—"}
            </dd>
          </div>
          <div>
            <dt>
              <Label>Retirement age</Label>
            </dt>
            <dd className="mt-1 font-mono text-base font-semibold tabular-nums">
              {kpis.retirementAge !== null ? kpis.retirementAge : "—"}
              {/* A lower retirement age is the better outcome, so this delta's
                  color sense is inverted relative to the money ones. */}
              {compareKpis && kpis.retirementAge !== null && cmpRetirementAge !== null && (
                <span
                  className={`ml-2 text-[11.5px] font-semibold ${
                    kpis.retirementAge - cmpRetirementAge <= 0 ? "text-positive" : "text-negative"
                  }`}
                >
                  {kpis.retirementAge - cmpRetirementAge >= 0 ? "+" : ""}
                  {kpis.retirementAge - cmpRetirementAge}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>
              <Label>{isFullRange ? "At end of plan" : `In ${lastYear?.year ?? ""}`}</Label>
            </dt>
            <dd className="mt-1 font-mono text-base font-semibold tabular-nums">{formatMoney(atEnd)}</dd>
          </div>
        </dl>
      </Tile>

      {/* ---- Two first-year cash-flow stats ---- */}
      <Tile area="k1" className="p-4">
        <Label>Operating surplus · {firstYear?.year ?? ""}</Label>
        <div
          className={`mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums ${
            surplus >= 0 ? "text-positive" : "text-negative"
          }`}
        >
          {formatMoney(surplus)}
        </div>
        <div className="mt-1.5 text-[11.5px] text-dim-2">
          {formatMoney(surplus / 12)} / mo after expenses
        </div>
      </Tile>

      <Tile area="k2" className="p-4">
        <Label>Savings rate · {firstYear?.year ?? ""}</Label>
        <div className="mt-1.5 font-mono text-2xl font-bold tracking-tight tabular-nums">
          {savingsRate === null ? "—" : `${savingsRate.toFixed(0)}%`}
        </div>
        <div className="mt-1.5 text-[11.5px] text-dim-2">
          {formatMoney(expenses)} spent of {formatMoney(income)}
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
          <Label>Accounts · {snapshotYear?.year ?? ""}</Label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2 text-[12.5px] last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <i
                  aria-hidden
                  className="block h-2 w-2 shrink-0 rounded-sm"
                  style={{ background: r.color }}
                />
                <span className="truncate">{r.name}</span>
              </span>
              <span className="shrink-0 font-mono tabular-nums text-dim">{formatMoney(r.value)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-1 flex items-center justify-between border-t border-border bg-panel-2 px-4 py-2.5 text-[12.5px] font-bold">
          <span>Net worth</span>
          <span className="font-mono tabular-nums">
            {formatMoney(snapshotYear ? deflateBalance(snapshotYear.netWorthNominal, snapshotYear, dollarMode) : 0)}
          </span>
        </div>
      </Tile>
    </div>
  );
}
