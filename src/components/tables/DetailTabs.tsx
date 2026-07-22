"use client";

import { useState } from "react";
import type {
  Account,
  ExpenseBaseline,
  ForecastSettings,
  Id,
  IncomeSource,
  LedgerEvent,
  Person,
  ScenarioEvent,
  TimelineRow,
  YearSnapshot,
} from "@/domain";
import type { DollarMode } from "@/lib/format";
import { AccountsTable } from "./AccountsTable";
import { CashFlowTable } from "./CashFlowTable";
import { TimelineTab } from "./TimelineTab";
import { MoneyFlowEditor } from "@/components/moneyflow/MoneyFlowEditor";

const TABS = ["Timeline", "Accounts", "Routing", "Cash Flow"] as const;
type Tab = (typeof TABS)[number];

export interface CompareTabData {
  name: string;
  accounts: Account[];
  years: YearSnapshot[];
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  events: ScenarioEvent[];
  people: Person[];
  settings: ForecastSettings;
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
}

export function DetailTabs({
  accounts,
  years,
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
  accounts: Account[];
  years: YearSnapshot[];
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
  const [active, setActive] = useState<Tab>("Cash Flow");
  const [viewingCompare, setViewingCompare] = useState(false);
  const showCompare = viewingCompare && compare !== null;

  // Routing edits directly mutate the active scenario in the store -- never
  // let it operate on the compared scenario's (read-only) data.
  const routingLocked = showCompare;

  const viewAccounts = showCompare ? compare!.accounts : accounts;
  const viewYears = showCompare ? compare!.years : years;
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-panel p-1 w-fit">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActive(tab)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active === tab ? "bg-accent text-white" : "text-dim hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        {compare && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-panel p-1 w-fit">
            <button
              type="button"
              onClick={() => setViewingCompare(false)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                !showCompare ? "bg-accent text-white" : "text-dim hover:text-foreground"
              }`}
            >
              {scenarioName}
            </button>
            <button
              type="button"
              onClick={() => setViewingCompare(true)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                showCompare ? "bg-accent text-white" : "text-dim hover:text-foreground"
              }`}
            >
              {compare.name}
            </button>
          </div>
        )}
      </div>
      {active === "Accounts" && (
        <AccountsTable
          accounts={viewAccounts}
          years={viewYears}
          editableAccountIds={viewEditableAccountIds}
          people={viewPeople}
          dollarMode={dollarMode}
          events={viewEvents}
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
      {active === "Cash Flow" && <CashFlowTable years={viewYears} accounts={viewAccounts} dollarMode={dollarMode} />}
    </div>
  );
}
