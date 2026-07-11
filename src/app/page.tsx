"use client";

import { useMemo, useState } from "react";
import type { Id } from "@/domain";
import type { DollarMode } from "@/lib/format";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { YearRangePicker } from "@/components/layout/YearRangePicker";
import { KpiStrip } from "@/components/kpi/KpiStrip";
import { NetWorthChart } from "@/components/chart/NetWorthChart";
import { DetailTabs } from "@/components/tables/DetailTabs";
import { WarningsBanner } from "@/components/layout/WarningsBanner";
import { usePlanStore } from "@/store/usePlanStore";
import { useProjection } from "@/store/useProjection";

function HomeContent() {
  const scenario = usePlanStore((state) => state.activeScenario());
  const projection = useProjection(scenario);

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
  const timeline = useMemo(
    () => projection.timeline.filter((t) => t.year >= range[0] && t.year <= range[1]),
    [projection.timeline, range]
  );
  const ledger = useMemo(
    () => projection.ledger.filter((e) => Number(e.date.slice(0, 4)) >= range[0] && Number(e.date.slice(0, 4)) <= range[1]),
    [projection.ledger, range]
  );
  const editableAccountIds = useMemo<Set<Id>>(
    () => new Set(scenario.accounts.map((a) => a.id)),
    [scenario.accounts]
  );

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <Header scenario={scenario} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
        <KpiStrip kpis={projection.kpis} dollarMode={dollarMode} />
        <WarningsBanner warnings={projection.warnings} accounts={projection.accounts} />
        <YearRangePicker
          minYear={minYear}
          maxYear={maxYear}
          rangeStart={range[0]}
          rangeEnd={range[1]}
          onChange={(start, end) => setRange([start, end])}
        />
        <NetWorthChart
          accounts={projection.accounts}
          years={years}
          dollarMode={dollarMode}
          onDollarModeChange={setDollarMode}
        />
        <DetailTabs
          accounts={projection.accounts}
          years={years}
          timeline={timeline}
          ledger={ledger}
          events={scenario.events}
          people={scenario.household.people}
          editableAccountIds={editableAccountIds}
          incomeSources={scenario.incomeSources}
          expenses={scenario.expenses}
          settings={scenario.settings}
          dollarMode={dollarMode}
        />
      </main>
      <Footer />
    </div>
  );
}

export default function Home() {
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
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
  return <HomeContent />;
}
