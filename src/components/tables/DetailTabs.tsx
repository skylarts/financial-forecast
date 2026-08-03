"use client";

import { useState } from "react";
import type { DetailView } from "@/lib/views";
import { Segmented } from "@/components/ui/controls";
import type {
  Account,
  ExpenseBaseline,
  ForecastSettings,
  Granularity,
  Id,
  IncomeSource,
  LedgerEvent,
  PeriodSnapshot,
  Person,
  ScenarioEvent,
  TimelineRow,
} from "@/domain";
import type { DollarMode } from "@/lib/format";
import { AccountsTable } from "./AccountsTable";
import { CashFlowTable } from "./CashFlowTable";
import { TimelineTab } from "./TimelineTab";
import { MoneyFlowEditor } from "@/components/moneyflow/MoneyFlowEditor";

// Which detail view to render is now driven by the header tab set.
type Tab = DetailView;

export interface CompareTabData {
  name: string;
  accounts: Account[];
  periods: PeriodSnapshot[];
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  events: ScenarioEvent[];
  people: Person[];
  settings: ForecastSettings;
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
}

export function DetailTabs({
  active,
  accounts,
  periods,
  granularity,
  timeline,
  ledger,
  events,
  people,
  editableAccountIds,
  incomeSources,
  expenses,
  settings,
  dollarMode,
  scenarioName,
  compare,
}: {
  active: Tab;
  accounts: Account[];
  /** Year or month snapshots for the selected range -- see `granularity`. */
  periods: PeriodSnapshot[];
  granularity: Granularity;
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  events: ScenarioEvent[];
  people: Person[];
  editableAccountIds: Set<Id>;
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  settings: ForecastSettings;
  dollarMode: DollarMode;
  scenarioName: string;
  compare: CompareTabData | null;
}) {
  const [viewingCompare, setViewingCompare] = useState(false);
  const showCompare = viewingCompare && compare !== null;

  // Routing edits directly mutate the active scenario in the store -- never
  // let it operate on the compared scenario's (read-only) data.
  const routingLocked = showCompare;

  const viewAccounts = showCompare ? compare!.accounts : accounts;
  const viewPeriods = showCompare ? compare!.periods : periods;
  const viewTimeline = showCompare ? compare!.timeline : timeline;
  const viewLedger = showCompare ? compare!.ledger : ledger;
  const viewEvents = showCompare ? compare!.events : events;
  const viewPeople = showCompare ? compare!.people : people;
  const viewEditableAccountIds = showCompare ? new Set(compare!.accounts.map((a) => a.id)) : editableAccountIds;
  const viewIncomeSources = showCompare ? compare!.incomeSources : incomeSources;
  const viewExpenses = showCompare ? compare!.expenses : expenses;
  const editableAccounts = viewAccounts.filter((a) => viewEditableAccountIds.has(a.id));

  return (
    <div>
      {/* Which scenario's numbers this detail view is showing. Only appears
          when a comparison is active; the view switcher itself is in the
          header now. */}
      {compare && (
        <div className="mb-3 flex justify-end">
          <Segmented
            ariaLabel="Which scenario to show"
            size="sm"
            options={[
              { value: "active", label: scenarioName },
              { value: "compare", label: compare.name },
            ]}
            value={showCompare ? "compare" : "active"}
            onChange={(v) => setViewingCompare(v === "compare")}
          />
        </div>
      )}
      {active === "Accounts" && (
        <AccountsTable
          accounts={viewAccounts}
          periods={viewPeriods}
          editableAccountIds={viewEditableAccountIds}
          people={viewPeople}
          dollarMode={dollarMode}
          events={viewEvents}
          granularity={granularity}
        />
      )}
      {active === "Timeline" && (
        <TimelineTab
          incomeSources={viewIncomeSources}
          expenses={viewExpenses}
          events={viewEvents}
          timeline={viewTimeline}
          ledger={viewLedger}
          accounts={viewAccounts}
          editableAccounts={editableAccounts}
          people={viewPeople}
        />
      )}
      {active === "Routing" &&
        (routingLocked ? (
          <div className="rounded-lg border border-border bg-panel p-4 text-sm text-dim">
            Routing can only be edited for {scenarioName}. Switch back to edit it.
          </div>
        ) : (
          <MoneyFlowEditor accounts={editableAccounts} settings={settings} />
        ))}
      {active === "Cash Flow" && (
        <CashFlowTable periods={viewPeriods} accounts={viewAccounts} dollarMode={dollarMode} granularity={granularity} />
      )}
    </div>
  );
}
