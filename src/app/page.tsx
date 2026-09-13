"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Granularity, Id, PeriodSnapshot } from "@/domain";
import type { DollarMode } from "@/lib/format";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ViewBar } from "@/components/layout/ViewBar";
import type { View } from "@/lib/views";
import { OverviewBento } from "@/components/kpi/OverviewBento";
import { DetailTabs } from "@/components/tables/DetailTabs";
import { WarningsBanner } from "@/components/layout/WarningsBanner";
import { StalePlanBanner } from "@/components/layout/StalePlanBanner";
import { RecoveryBanner } from "@/components/layout/RecoveryBanner";
import { Notices } from "@/components/layout/Notices";
import { EmptyForecast } from "@/components/layout/EmptyForecast";
import { usePlanStore, planHasContent } from "@/store/usePlanStore";
import { useWizardStore } from "@/store/useWizardStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { useProjection, useCompareProjection } from "@/store/useProjection";
import { useCloudSync } from "@/store/useCloudSync";
import { useUiStore } from "@/store/useUiStore";
import { SetupWizardHost } from "@/components/wizard/SetupWizardHost";
import { JoyConfetti } from "@/components/joy/JoyConfetti";
import { JoyQuote } from "@/components/joy/JoyQuote";
import { ThemeSync } from "@/components/layout/ThemeToggle";
import { todayISO } from "@/engine/dateMath";
import { STRESS_PRESETS } from "@/engine/stress";
import { useStressProjection } from "@/store/useStress";

/**
 * Recharts is a sizeable chunk of JS that the rest of the Overview page
 * (KPIs, the account snapshot) doesn't need, so it loads separately from the
 * bundle those need to become interactive. `ssr: false` because the chart
 * reads its own container width client-side; a fixed-height placeholder holds
 * its place so the layout doesn't jump once it's loaded.
 */
const NetWorthChart = dynamic(
  () => import("@/components/chart/NetWorthChart").then((m) => m.NetWorthChart),
  {
    ssr: false,
    loading: () => <div className="h-[320px] w-full animate-pulse rounded-md bg-panel-2" />,
  },
);

function HomeContent() {
  const scenario = usePlanStore((state) => state.activeScenario());
  const projection = useProjection(scenario);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const [view, setView] = useState<View>("Overview");
  const plan = usePlanStore((s) => s.plan);
  const hasContent = planHasContent(plan);
  const openWizard = useWizardStore((s) => s.openWizard);
  const loadSamplePlan = usePlanStore((s) => s.loadSamplePlan);
  const requestRestore = useUiStore((s) => s.requestRestore);

  const allScenarios = usePlanStore((s) => s.plan.scenarios);
  const compareScenarioId = usePlanStore((s) => s.compareScenarioId);
  const setCompareScenarioId = usePlanStore((s) => s.setCompareScenarioId);
  const compareScenarioRaw = allScenarios.find((s) => s.id === compareScenarioId) ?? null;
  const compareProjection = useCompareProjection(compareScenarioRaw, projection);
  const hasCompare = compareScenarioRaw !== null;

  const minYear = projection.years[0]?.year ?? new Date().getFullYear();
  const maxYear = projection.years[projection.years.length - 1]?.year ?? minYear;
  const [pickedRange, setRange] = useState<[number, number]>([minYear, Math.min(maxYear, minYear + 19)]);
  // A restored backup or a switch to a scenario with a different span can
  // leave the picked years outside the plan: read them clamped back in.
  const range = useMemo<[number, number]>(() => {
    const s = Math.min(Math.max(pickedRange[0], minYear), maxYear);
    const e = Math.min(Math.max(pickedRange[1], s), maxYear);
    return [s, e];
  }, [pickedRange, minYear, maxYear]);
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

  // A stress preset drawn as a second line on the Overview chart; chosen
  // from the chart's own menu or the Stress test tab.
  const stressOverlay = useUiStore((s) => s.stressOverlay);
  const setStressOverlay = useUiStore((s) => s.setStressOverlay);
  const stressParams = useUiStore((s) => s.stressParams);
  const stressRun = useStressProjection(scenario, view === "Overview" ? stressOverlay : null, stressParams);
  const stressYears = useMemo(
    () => (stressRun ? stressRun.result.years.filter((y) => y.year >= range[0] && y.year <= range[1]) : []),
    [stressRun, range]
  );

  // --- Monthly drill-down -------------------------------------------------
  // The Cash Flow and Accounts tables can show one column per MONTH over the
  // engine's bounded monthly window (see MONTHLY_DETAIL_YEARS) -- the lens for
  // "what does cash flow look like around this purchase". Everything else
  // (Overview, Timeline, Routing) stays annual, so the toggle is only offered
  // on the two views that can honor it.
  const [granularity, setGranularity] = useState<Granularity>("year");
  const monthOptions = useMemo(
    () => projection.months.map((m) => ({ key: m.periodKey, label: m.periodLabel })),
    [projection.months]
  );
  const DEFAULT_MONTH_SPAN = 24;
  const defaultMonthRange = useMemo<[string, string]>(() => {
    if (monthOptions.length === 0) return ["", ""];
    return [monthOptions[0].key, monthOptions[Math.min(monthOptions.length, DEFAULT_MONTH_SPAN) - 1].key];
  }, [monthOptions]);
  // Null until the user picks a range; also falls back whenever a plan edit
  // moves the horizon out from under a previously-chosen month.
  const [pickedMonthRange, setPickedMonthRange] = useState<[string, string] | null>(null);
  const monthRange =
    pickedMonthRange && monthOptions.some((m) => m.key === pickedMonthRange[0]) && monthOptions.some((m) => m.key === pickedMonthRange[1])
      ? pickedMonthRange
      : defaultMonthRange;

  const granularityAvailable = view === "Cash Flow" || view === "Accounts";
  const effectiveGranularity: Granularity =
    granularityAvailable && granularity === "month" && monthOptions.length > 0 ? "month" : "year";

  const [fromMonth, toMonth] = monthRange;
  const sliceMonths = (months: PeriodSnapshot[]) => months.filter((m) => m.periodKey >= fromMonth && m.periodKey <= toMonth);
  const periods = useMemo(
    () => (effectiveGranularity === "month" ? sliceMonths(projection.months) : years),
    [effectiveGranularity, projection.months, years, fromMonth, toMonth] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const comparePeriods = useMemo(
    () => (effectiveGranularity === "month" ? sliceMonths(compareProjection.months) : compareYears),
    [effectiveGranularity, compareProjection.months, compareYears, fromMonth, toMonth] // eslint-disable-line react-hooks/exhaustive-deps
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
        view={view}
        minYear={minYear}
        maxYear={maxYear}
        rangeStart={range[0]}
        rangeEnd={range[1]}
        onRangeChange={(start, end) => setRange([start, end])}
        granularity={granularity}
        onGranularityChange={setGranularity}
        granularityAvailable={granularityAvailable && monthOptions.length > 0}
        monthOptions={monthOptions}
        monthStart={monthRange[0]}
        monthEnd={monthRange[1]}
        onMonthRangeChange={(start, end) => setPickedMonthRange([start, end])}
        dollarMode={dollarMode}
        onDollarModeChange={setDollarMode}
        compareOptions={compareOptions}
        compareScenarioId={compareScenarioId}
        onCompareChange={setCompareScenarioId}
      />

      {/* Banners sit above whichever view is showing -- a stale plan or an
          insufficient-funds warning is worth seeing regardless of which tab
          you happen to be on. */}
      <div className="flex flex-col gap-3 px-3 sm:px-6 pt-4 empty:hidden">
        <RecoveryBanner />
        {hasContent && <StalePlanBanner scenario={scenario} />}
        {hasContent && <WarningsBanner warnings={projection.warnings} accounts={projection.accounts} onOpenRouting={() => setView("Routing")} />}
      </div>

      {!hasContent ? (
        <main className="flex w-full flex-1 flex-col">
          <EmptyForecast onSetUp={openWizard} onRestore={requestRestore} onLoadSample={loadSamplePlan} />
        </main>
      ) : view === "Overview" ? (
        <main className="flex w-full flex-1 flex-col gap-3 px-3 sm:px-6 py-4">
          {isJoy && <JoyQuote />}
          <OverviewBento
            projection={projection}
            years={years}
            accounts={projection.accounts}
            dollarMode={dollarMode}
            planStartDate={scenario.settings.startDate ?? todayISO()}
            people={scenario.household.people}
            events={scenario.events}
            compare={hasCompare ? { name: compareScenarioRaw!.name, projection: compareProjection } : null}
            chart={
              <NetWorthChart
                accounts={projection.accounts}
                editableAccounts={editableAccounts}
                years={years}
                dollarMode={dollarMode}
                onDollarModeChange={setDollarMode}
                minYear={minYear}
                maxYear={maxYear}
                rangeStart={range[0]}
                rangeEnd={range[1]}
                onRangeChange={(start, end) => setRange([start, end])}
                events={scenario.events}
                incomeSources={scenario.incomeSources}
                expenses={scenario.expenses}
                people={scenario.household.people}
                scenarioName={scenario.name}
                compareOptions={compareOptions}
                compareScenarioId={compareScenarioId}
                stressOptions={STRESS_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
                stressKey={stressOverlay}
                onStressChange={setStressOverlay}
                stressScenario={stressRun ? { label: stressRun.label, description: stressRun.description, years: stressYears } : null}
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
            }
          />
        </main>
      ) : (
        <main className="flex w-full flex-1 flex-col px-3 sm:px-6 py-4">
          <DetailTabs
            active={view}
          accounts={projection.accounts}
          periods={periods}
          granularity={effectiveGranularity}
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
          scenario={scenario}
          projection={projection}
          compare={
            hasCompare
              ? {
                  name: compareScenarioRaw!.name,
                  accounts: compareProjection.accounts,
                  periods: comparePeriods,
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
      <Notices />
    </div>
  );
}

export default function Home() {
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const { cloudSyncReady } = useCloudSync();
  const { loading: authLoading } = useAuth();
  // Next.js SSRs with the default plan; localStorage is only readable
  // client-side, so avoid rendering (and flashing default data) until the
  // real persisted plan has loaded. A signed-in user also waits for the
  // cloud read to settle, so an edit made in the first seconds can never be
  // overwritten by the copy that then arrives.
  if (!hasHydrated || authLoading || !cloudSyncReady) {
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
