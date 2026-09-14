"use client";

import { useState } from "react";
import type { Account, DateAnchor, ExpenseBaseline, IncomeSource, Person, ScenarioEvent, TimelineRow } from "@/domain";
import { retirementsInOrder } from "@/domain";
import { useAssumptionsStore } from "@/store/useAssumptionsStore";
import { AnchorChip } from "@/components/ui/AnchoredDate";
import { formatMoney } from "@/lib/format";
import { eventBadgeLabel, templateBadge, INCOME_CATEGORY_BADGES, freqLabel } from "@/lib/timelineFormat";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";

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
  /** Retirement links on this item's dates -- shown as chips so a derived date reads as derived. */
  anchors?: (DateAnchor | null | undefined)[];
  open: () => void;
}

/** A temporary adjustment's multiplier as the change it is: ×0.5 = "−50%", 0 = "paused". */
function changeLabel(multiplier: number): string {
  if (multiplier === 0) return "paused";
  const pct = Math.round((multiplier - 1) * 1000) / 10;
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

/**
 * Everything you entered, in date order: income, expenses, their temporary
 * changes, and life events. What the engine moved on its own (withdrawals,
 * RMDs, sweeps) lives on the Cash Flow tab, where the money is.
 */
export function TimelineTab({
  incomeSources,
  expenses,
  events,
  timeline,
  editableAccounts,
  people,
  readOnly = false,
}: {
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  events: ScenarioEvent[];
  /** Full (unfiltered) event descriptions from the engine, keyed by eventId below. */
  timeline: TimelineRow[];
  editableAccounts: Account[];
  people: Person[];
  /** True while showing the compared scenario: nothing here may be edited. */
  readOnly?: boolean;
}) {
  const [incomeDrawer, setIncomeDrawer] = useState<{ open: boolean; item?: IncomeSource }>({ open: false });
  const [expenseDrawer, setExpenseDrawer] = useState<{ open: boolean; item?: ExpenseBaseline }>({ open: false });
  const [eventDrawer, setEventDrawer] = useState<{ open: boolean; item?: ScenarioEvent }>({ open: false });
  const openAssumptions = useAssumptionsStore((s) => s.openAssumptions);

  const ownerName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "" : "Joint");
  const timelineById = new Map(timeline.map((t) => [t.eventId, t]));
  const guard = (fn: () => void) => (readOnly ? () => {} : fn);

  const rows: Row[] = [];

  for (const inc of incomeSources) {
    rows.push({
      key: `inc-${inc.id}`,
      date: inc.startDate,
      tone: "income",
      badge: templateBadge(inc.templateId) ?? INCOME_CATEGORY_BADGES[inc.category] ?? "Income",
      name: inc.name,
      detail: `${formatMoney(inc.amount)}${freqLabel(inc.frequency, inc.intervalYears)} · ${ownerName(inc.ownerId)}`,
      excluded: inc.isExcluded ?? false,
      anchors: [inc.startAnchor, inc.endAnchor],
      open: guard(() => setIncomeDrawer({ open: true, item: inc })),
    });
    for (const adj of inc.adjustments ?? []) {
      rows.push({
        key: `inc-adj-${adj.id}`,
        date: adj.startDate,
        tone: "change",
        badge: "Income change",
        name: `${inc.name}: ${changeLabel(adj.multiplier)}`,
        detail: adj.endDate ? `through ${adj.endDate}` : "ongoing",
        excluded: inc.isExcluded ?? false,
        open: guard(() => setIncomeDrawer({ open: true, item: inc })),
      });
    }
  }

  for (const exp of expenses) {
    rows.push({
      key: `exp-${exp.id}`,
      date: exp.startDate,
      tone: "expense",
      badge: templateBadge(exp.templateId) ?? "Expense",
      name: exp.name,
      detail: `${formatMoney(exp.amount)}${freqLabel(exp.frequency, exp.intervalYears)}`,
      excluded: exp.isExcluded ?? false,
      anchors: [exp.startAnchor, exp.endAnchor],
      open: guard(() => setExpenseDrawer({ open: true, item: exp })),
    });
    for (const adj of exp.adjustments ?? []) {
      rows.push({
        key: `exp-adj-${adj.id}`,
        date: adj.startDate,
        tone: "change",
        badge: "Expense change",
        name: `${exp.name}: ${changeLabel(adj.multiplier)}`,
        detail: adj.endDate ? `through ${adj.endDate}` : "ongoing",
        excluded: exp.isExcluded ?? false,
        open: guard(() => setExpenseDrawer({ open: true, item: exp })),
      });
    }
  }

  // Retirement has no event to iterate any more: one row per person who
  // retires, built from the household, opening the Assumptions drawer (which
  // is where retirement is edited) rather than an event drawer.
  for (const { person, date } of retirementsInOrder(people)) {
    rows.push({
      key: `retire-${person.id}`,
      date,
      tone: "event",
      badge: "Retire",
      name: `${person.name} retires`,
      detail: timelineById.get(`retirement:${person.id}`)?.description ?? `${person.name} retires`,
      excluded: false,
      open: guard(() => openAssumptions()),
    });
  }

  for (const ev of events) {
    const t = timelineById.get(ev.id);
    rows.push({
      key: `ev-${ev.id}`,
      date: ev.startDate,
      tone: "event",
      badge: eventBadgeLabel(ev),
      name: ev.name,
      detail: t?.description ?? "",
      excluded: ev.isExcluded ?? false,
      anchors: [ev.startAnchor, ev.endAnchor],
      open: guard(() => setEventDrawer({ open: true, item: ev })),
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || TONE_SORT[a.tone] - TONE_SORT[b.tone]);

  const addButton = "rounded-md border border-border bg-panel px-3 py-1.5 text-sm font-medium text-dim hover:border-accent hover:text-foreground";

  return (
    <div className="flex flex-col gap-4">
      {!readOnly && (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setIncomeDrawer({ open: true, item: undefined })} className={addButton}>
            + Income
          </button>
          <button type="button" onClick={() => setExpenseDrawer({ open: true, item: undefined })} className={addButton}>
            + Expense
          </button>
          <button
            type="button"
            onClick={() => setEventDrawer({ open: true, item: undefined })}
            className="rounded-md bg-pri px-3 py-1.5 text-sm font-semibold text-pri-fg"
          >
            + Life event
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-2 text-[11px] font-semibold text-dim">
          <span>Everything you entered, in date order</span>
          <span className="font-normal text-dim-2">
            {readOnly ? "Read-only while comparing" : "Click a row to edit it. The whole plan is listed, whatever year range is selected."}
          </span>
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] text-dim">
              <th className="py-2 pl-2 font-medium">Date</th>
              <th className="py-2 font-medium">Type</th>
              <th className="py-2 pr-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={`border-t border-border ${readOnly ? "" : "cursor-pointer hover:bg-background/40"} ${row.excluded ? "opacity-50" : ""}`}
                onClick={row.open}
              >
                <td className="whitespace-nowrap py-2 pl-2 align-top text-[10.5px] text-dim sm:text-[12.5px]">{row.date}</td>
                {/* `whitespace-nowrap` because a pill that wraps renders as two
                    half-pills stacked on top of each other. The smaller type
                    and tighter padding below `sm` buy the room to keep it on
                    one line in a narrow column. */}
                <td className="py-2 pr-2 align-top">
                  <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[9.5px] sm:px-2 sm:text-[11px] ${TONE_CLASS[row.tone]}`}>
                    {row.badge}
                  </span>
                </td>
                <td className="py-2 pr-2 align-top text-[11.5px] sm:text-[12.5px]">
                  <span className="font-medium">{row.name}</span>
                  {row.detail && <span className="text-dim"> — {row.detail}</span>}
                  {row.excluded && <span className="ml-2 text-[11px] text-dim">(excluded)</span>}
                  {row.anchors?.filter((a): a is DateAnchor => !!a).map((a, i) => (
                    <span key={i} className="ml-1.5 inline-block">
                      <AnchorChip anchor={a} people={people} />
                    </span>
                  ))}
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
        incomeSources={incomeSources}
      />
    </div>
  );
}
