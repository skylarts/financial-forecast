"use client";

import { Fragment, useState } from "react";
import type {
  Account,
  ExpenseBaseline,
  IncomeSource,
  LedgerEvent,
  Person,
  ScenarioEvent,
  TimelineRow,
} from "@/domain";
import { formatMoney } from "@/lib/format";
import { groupLedgerByYear } from "@/lib/groupLedger";
import { EVENT_TYPE_LABELS, INCOME_CATEGORY_BADGES, freqLabel } from "@/lib/timelineFormat";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";

const LEDGER_KIND_LABELS: Record<LedgerEvent["kind"], string> = {
  rmd: "RMD",
  deficit_withdrawal: "Withdrawal",
  mortgage_payment: "Mortgage",
  surplus_route: "Surplus routed",
  cap_overflow: "Cap overflow",
  tax_settlement: "Tax true-up",
  home_sale: "Home sale",
};

// Visual tone per row type, and a sort tiebreak so items sharing a start date
// (typically everything at plan start) read income -> expense -> changes -> events.
type Tone = "income" | "expense" | "change" | "event";
const TONE_CLASS: Record<Tone, string> = {
  income: "bg-positive/20 text-positive",
  expense: "bg-negative/20 text-negative",
  change: "bg-accent/10 text-dim",
  event: "bg-accent/20 text-accent",
};
const TONE_SORT: Record<Tone, number> = { income: 0, expense: 1, change: 2, event: 3 };

interface Row {
  key: string;
  date: string;
  tone: Tone;
  badge: string;
  name: string;
  detail: string;
  excluded: boolean;
  open: () => void;
}

function fmt(n: number): string {
  return `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function TimelineTab({
  incomeSources,
  expenses,
  events,
  timeline,
  ledger,
  accounts,
  editableAccounts,
  people,
}: {
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  events: ScenarioEvent[];
  /** Full (unfiltered) event descriptions from the engine, keyed by eventId below. */
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  accounts: Account[];
  editableAccounts: Account[];
  people: Person[];
}) {
  const [incomeDrawer, setIncomeDrawer] = useState<{ open: boolean; item?: IncomeSource }>({ open: false });
  const [expenseDrawer, setExpenseDrawer] = useState<{ open: boolean; item?: ExpenseBaseline }>({ open: false });
  const [eventDrawer, setEventDrawer] = useState<{ open: boolean; item?: ScenarioEvent }>({ open: false });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const ownerName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "" : "Joint");
  const timelineById = new Map(timeline.map((t) => [t.eventId, t]));

  const rows: Row[] = [];

  for (const inc of incomeSources) {
    rows.push({
      key: `inc-${inc.id}`,
      date: inc.startDate,
      tone: "income",
      badge: INCOME_CATEGORY_BADGES[inc.category] ?? "Income",
      name: inc.name,
      detail: `${formatMoney(inc.amount)}${freqLabel(inc.frequency, inc.intervalYears)} · ${ownerName(inc.ownerId)}`,
      excluded: inc.isExcluded ?? false,
      open: () => setIncomeDrawer({ open: true, item: inc }),
    });
    for (const adj of inc.adjustments ?? []) {
      rows.push({
        key: `inc-adj-${adj.id}`,
        date: adj.startDate,
        tone: "change",
        badge: "Income change",
        name: `${inc.name}: ×${adj.multiplier}`,
        detail: adj.endDate ? `through ${adj.endDate}` : "ongoing",
        excluded: inc.isExcluded ?? false,
        open: () => setIncomeDrawer({ open: true, item: inc }),
      });
    }
  }

  for (const exp of expenses) {
    rows.push({
      key: `exp-${exp.id}`,
      date: exp.startDate,
      tone: "expense",
      badge: "Expense",
      name: exp.name,
      detail: `${formatMoney(exp.amount)}${freqLabel(exp.frequency, exp.intervalYears)}`,
      excluded: exp.isExcluded ?? false,
      open: () => setExpenseDrawer({ open: true, item: exp }),
    });
    for (const adj of exp.adjustments ?? []) {
      rows.push({
        key: `exp-adj-${adj.id}`,
        date: adj.startDate,
        tone: "change",
        badge: "Expense change",
        name: `${exp.name}: ×${adj.multiplier}`,
        detail: adj.endDate ? `through ${adj.endDate}` : "ongoing",
        excluded: exp.isExcluded ?? false,
        open: () => setExpenseDrawer({ open: true, item: exp }),
      });
    }
  }

  for (const ev of events) {
    const t = timelineById.get(ev.id);
    rows.push({
      key: `ev-${ev.id}`,
      date: ev.startDate,
      tone: "event",
      badge: EVENT_TYPE_LABELS[ev.type] ?? ev.type,
      name: ev.name,
      detail: t?.description ?? "",
      excluded: ev.isExcluded ?? false,
      open: () => setEventDrawer({ open: true, item: ev }),
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || TONE_SORT[a.tone] - TONE_SORT[b.tone]);

  const ledgerGroups = groupLedgerByYear(ledger);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "an account";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setIncomeDrawer({ open: true, item: undefined })}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          + Income
        </button>
        <button
          type="button"
          onClick={() => setExpenseDrawer({ open: true, item: undefined })}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          + Expense
        </button>
        <button
          type="button"
          onClick={() => setEventDrawer({ open: true, item: undefined })}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          + Event
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-panel">
        <div className="border-b border-border px-2 py-2 text-xs font-semibold text-dim">
          Timeline — income, expenses &amp; life events, in date order
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-dim">
              <th className="py-2 pl-2 font-medium">Date</th>
              <th className="py-2 font-medium">Type</th>
              <th className="py-2 pr-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={`cursor-pointer border-t border-border hover:bg-background/40 ${row.excluded ? "opacity-50" : ""}`}
                onClick={row.open}
              >
                <td className="whitespace-nowrap py-2 pl-2 text-dim">{row.date}</td>
                <td className="py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${TONE_CLASS[row.tone]}`}>{row.badge}</span>
                </td>
                <td className="py-2 pr-2">
                  <span className="font-medium">{row.name}</span>
                  {row.detail && <span className="text-dim"> — {row.detail}</span>}
                  {row.excluded && <span className="ml-2 text-xs text-dim">(excluded)</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 text-center text-dim">
                  Nothing yet — add income, an expense, or an event above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-panel">
        <div className="border-b border-border px-2 py-2 text-xs font-semibold text-dim">
          Automatic Withdrawals &amp; RMDs
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-dim">
              <th className="py-2 pl-2 font-medium">Year</th>
              <th className="py-2 font-medium">Kind</th>
              <th className="py-2 font-medium">Account</th>
              <th className="py-2 pr-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {ledgerGroups.map((group) => {
              const expanded = expandedGroups.has(group.key);
              return (
                <Fragment key={group.key}>
                  <tr
                    className="cursor-pointer border-t border-border hover:bg-background/40"
                    onClick={() => toggleGroup(group.key)}
                  >
                    <td className="py-1.5 pl-2 text-dim">
                      <span className="mr-1 inline-block w-3 text-xs text-dim">{expanded ? "▾" : "▸"}</span>
                      {group.year}
                    </td>
                    <td className="py-1.5">
                      <span className="rounded bg-positive/20 px-2 py-0.5 text-xs text-positive">
                        {LEDGER_KIND_LABELS[group.kind]}
                      </span>
                    </td>
                    <td className="py-1.5 text-dim">
                      {accountName(group.accountId)}
                      {group.toAccountId ? ` → ${accountName(group.toAccountId)}` : ""}
                      {" · "}
                      {group.entries.length} payment{group.entries.length === 1 ? "" : "s"}
                    </td>
                    <td className="py-1.5 pr-2 text-right">{fmt(group.totalAmount)}</td>
                  </tr>
                  {expanded &&
                    group.entries.map((entry, i) => (
                      <tr key={`${group.key}-${i}`} className="border-t border-border/50 bg-background/20">
                        <td className="py-1 pl-6 text-xs text-dim">{entry.date}</td>
                        <td className="py-1" />
                        <td className="py-1 text-xs text-dim">{entry.note}</td>
                        <td className="py-1 pr-2 text-right text-xs text-dim">{fmt(entry.amount)}</td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            {ledgerGroups.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-dim">
                  None in this scenario.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <IncomeDrawer
        key={`income-${incomeDrawer.open}-${incomeDrawer.item?.id ?? "new"}`}
        open={incomeDrawer.open}
        onClose={() => setIncomeDrawer({ open: false })}
        income={incomeDrawer.item}
        people={people}
        accounts={editableAccounts}
      />
      <ExpenseDrawer
        key={`expense-${expenseDrawer.open}-${expenseDrawer.item?.id ?? "new"}`}
        open={expenseDrawer.open}
        onClose={() => setExpenseDrawer({ open: false })}
        expense={expenseDrawer.item}
        accounts={editableAccounts}
      />
      <EventDrawer
        open={eventDrawer.open}
        onClose={() => setEventDrawer({ open: false })}
        event={eventDrawer.item}
        accounts={editableAccounts}
        people={people}
      />
    </div>
  );
}
