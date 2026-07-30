"use client";

import { useMemo, useState } from "react";
import type { Id } from "@/domain";
import type { DollarMode } from "@/lib/format";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ViewBar } from "@/components/layout/ViewBar";
import type { View } from "@/lib/views";
import { KpiStrip } from "@/components/kpi/KpiStrip";
import { NetWorthChart } from "@/components/chart/NetWorthChart";
import { DetailTabs } from "@/components/tables/DetailTabs";
import { WarningsBanner } from "@/components/layout/WarningsBanner";
import { StalePlanBanner } from "@/components/layout/StalePlanBanner";
import { usePlanStore } from "@/store/usePlanStore";
import { useProjection } from "@/store/useProjection";
import { useCloudSync } from "@/store/useCloudSync";
import { useUiStore } from "@/store/useUiStore";
import { SetupWizardHost } from "@/components/wizard/SetupWizardHost";
import { JoyConfetti } from "@/components/joy/JoyConfetti";
import { JoyQuote } from "@/components/joy/JoyQuote";
import { ThemeSync } from "@/components/layout/ThemeToggle";

function HomeContent() {
  const scenario = usePlanStore((state) => state.activeScenario());
  const projection = useProjection(scenario);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const lastSavedAt = usePlanStore((s) => s.lastSavedAt);
  const [view, setView] = useState<View>("Overview");

  const allScenarios = usePlanStore((s) => s.plan.scenarios);
  const compareScenarioId = usePlanStore((s) => s.compareScenarioId);
  const setCompareScenarioId = usePlanStore((s) => s.setCompareScenarioId);
  const compareScenarioRaw = allScenarios.find((s) => s.id === compareScenarioId) ?? null;
  const compareProjection = useProjection(compareScenarioRaw ?? scenario);
  const hasCompare = compareScenarioRaw !== null;

  const minYear = projection.years[0]?.year ?? new Date().getFullYear();
  const maxYear = projection.years[projection.years.length - 1]?.year ?? minYear;
  const [range, setRange] = useState<[number, number]>([minYear, Math.min(maxYear, minYear + 19)]);
  // Single display toggle: future (nominal) vs today's (real) dollars, applied
  // consistently across the KPIs, chart, and all tables. Defaults to real
  // (today's dollars) since that's the more meaningful lens for a long horizon.
  const [dollarMode, setDollarMode] = useState<DollarMode>("real");

  const years = useMemo(
    () => projection.years.filter((y) => y.year >= range[0] && y.year <= range[1]),
    [projection.years, range]
  );
  const compareYears = useMemo(
    () => (hasCompare ? compareProjection.years.filter((y) => y.year >= range[0] && y.year <= range[1]) : []),
    [hasCompare, compareProjection.years, range]
  );
  // The Timeline tab shows your whole plan (all income/expenses/events) and the
  // full auto-withdrawal ledger, independent of the chart's year window -- the
  // range picker only narrows the projection views (chart, Accounts, Cash Flow).
  const editableAccountIds = useMemo<Set<Id>>(
    () => new Set(scenario.accounts.map((a) => a.id)),
    [scenario.accounts]
  );
  const editableAccounts = useMemo(
    () => projection.accounts.filter((a) => editableAccountIds.has(a.id)),
    [projection.accounts, editableAccountIds]
  );
  const compareOptions = useMemo(
    () => allScenarios.filter((s) => s.id !== scenario.id).map((s) => ({ id: s.id, name: s.name })),
    [allScenarios, scenario.id]
  );

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <ThemeSync />
      {/* Celebrate once when joy mode is on and the plan reaches retirement. */}
      <JoyConfetti fire={isJoy && projection.kpis.retirementAge !== null} />
      <Header scenario={scenario} view={view} onViewChange={setView} />
      <ViewBar
        minYear={minYear}
        maxYear={maxYear}
        rangeStart={range[0]}
        rangeEnd={range[1]}
        onRangeChange={(start, end) => setRange([start, end])}
        dollarMode={dollarMode}
        onDollarModeChange={setDollarMode}
        compareOptions={compareOptions}
        compareScenarioId={compareScenarioId}
        onCompareChange={setCompareScenarioId}
        savedToBrowser={lastSavedAt > 0}
      />

      {/* Banners sit above whichever view is showing -- a stale plan or an
          insufficient-funds warning is worth seeing regardless of which tab
          you happen to be on. */}
      <div className="flex flex-col gap-3 px-6 pt-4 empty:hidden">
        <StalePlanBanner scenario={scenario} />
        <WarningsBanner warnings={projection.warnings} accounts={projection.accounts} />
      </div>

      {view === "Overview" ? (
        <main className="flex w-full flex-1 flex-col gap-4 px-6 py-4">
          <KpiStrip
            kpis={projection.kpis}
            years={years}
            dollarMode={dollarMode}
            isFullRange={range[0] === minYear && range[1] === maxYear}
            compareKpis={hasCompare ? compareProjection.kpis : null}
            compareYears={compareYears}
            compareName={hasCompare ? compareScenarioRaw!.name : null}
          />
          {isJoy && <JoyQuote />}
          <NetWorthChart
            accounts={projection.accounts}
            editableAccounts={editableAccounts}
            years={years}
            dollarMode={dollarMode}
            events={scenario.events}
            incomeSources={scenario.incomeSources}
            expenses={scenario.expenses}
            people={scenario.household.people}
            scenarioName={scenario.name}
            compareOptions={compareOptions}
            compareScenarioId={compareScenarioId}
            compareScenario={
              hasCompare
                ? {
                    name: compareScenarioRaw!.name,
                    years: compareYears,
                    events: compareScenarioRaw!.events,
                    incomeSources: compareScenarioRaw!.incomeSources,
                    expenses: compareScenarioRaw!.expenses,
                    people: compareScenarioRaw!.household.people,
                  }
                : null
            }
          />
        </main>
      ) : (
        <main className="flex w-full flex-1 flex-col px-6 py-4">
          <DetailTabs
            active={view}
          accounts={projection.accounts}
          years={years}
          timeline={projection.timeline}
          ledger={projection.ledger}
          events={scenario.events}
          people={scenario.household.people}
          editableAccountIds={editableAccountIds}
          incomeSources={scenario.incomeSources}
          expenses={scenario.expenses}
          settings={scenario.settings}
          dollarMode={dollarMode}
          scenarioName={scenario.name}
          compare={
            hasCompare
              ? {
                  name: compareScenarioRaw!.name,
                  accounts: compareProjection.accounts,
                  years: compareYears,
                  timeline: compareProjection.timeline,
                  ledger: compareProjection.ledger,
                  events: compareScenarioRaw!.events,
                  people: compareScenarioRaw!.household.people,
                  settings: compareScenarioRaw!.settings,
                  incomeSources: compareScenarioRaw!.incomeSources,
                  expenses: compareScenarioRaw!.expenses,
                }
              : null
            }
          />
        </main>
      )}
      <Footer />
    </div>
  );
}

export default function Home() {
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const { cloudSyncReady } = useCloudSync();
  // Next.js SSRs with the default plan; localStorage is only readable
  // client-side, so avoid rendering (and flashing default data) until the
  // real persisted plan has loaded.
  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen flex-1 items-center justify-center text-sm text-dim">
        Loading your plan…
      </div>
    );
  }
  return (
    <>
      <HomeContent />
      <SetupWizardHost cloudSyncReady={cloudSyncReady} />
    </>
  );
}
