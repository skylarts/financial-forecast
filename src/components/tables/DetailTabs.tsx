"use client";

import { useState } from "react";
import type {
  Account,
  ExpenseBaseline,
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
import { IncomeExpensesTable } from "./IncomeExpensesTable";
import { EventsTable } from "@/components/events/EventsTable";

const TABS = ["Accounts", "Income & Expenses", "Cash Flow", "Events"] as const;
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
  dollarMode: DollarMode;
}) {
  const [active, setActive] = useState<Tab>("Accounts");

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
      {active === "Income & Expenses" && (
        <IncomeExpensesTable
          incomeSources={incomeSources}
          expenses={expenses}
          accounts={accounts.filter((a) => editableAccountIds.has(a.id))}
          people={people}
        />
      )}
      {active === "Cash Flow" && <CashFlowTable years={years} accounts={accounts} dollarMode={dollarMode} />}
      {active === "Events" && (
        <EventsTable
          timeline={timeline}
          ledger={ledger}
          accounts={accounts}
          events={events}
          editableAccounts={accounts.filter((a) => editableAccountIds.has(a.id))}
          people={people}
          incomeSources={incomeSources}
          expenses={expenses}
        />
      )}
    </div>
  );
}
