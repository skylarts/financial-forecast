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

const TABS = ["Cash Flow", "Accounts", "Timeline", "Routing"] as const;
type Tab = (typeof TABS)[number];

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
}) {
  const [active, setActive] = useState<Tab>("Accounts");
  const editableAccounts = accounts.filter((a) => editableAccountIds.has(a.id));

  return (
    <div>
      <div className="mb-3 flex items-center gap-1 rounded-lg border border-border bg-panel p-1 w-fit">
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
      {active === "Accounts" && (
        <AccountsTable
          accounts={accounts}
          years={years}
          editableAccountIds={editableAccountIds}
          people={people}
          dollarMode={dollarMode}
        />
      )}
      {active === "Timeline" && (
        <TimelineTab
          incomeSources={incomeSources}
          expenses={expenses}
          events={events}
          timeline={timeline}
          ledger={ledger}
          accounts={accounts}
          editableAccounts={editableAccounts}
          people={people}
        />
      )}
      {active === "Routing" && <MoneyFlowEditor accounts={editableAccounts} settings={settings} />}
      {active === "Cash Flow" && <CashFlowTable years={years} accounts={accounts} dollarMode={dollarMode} />}
    </div>
  );
}
