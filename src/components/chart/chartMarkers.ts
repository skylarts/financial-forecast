import type { ExpenseBaseline, IncomeSource, Person, ScenarioEvent, TimelineRow } from "@/domain";
import { formatMoney } from "@/lib/format";
import { EVENT_TYPE_LABELS, INCOME_CATEGORY_BADGES, freqLabel } from "@/lib/timelineFormat";
import { EVENT_TYPE_ICONS, EXPENSE_CATEGORY_ICONS, INCOME_CATEGORY_ICONS, type MarkerKind } from "./eventIcons";

export interface ChartMarker {
  key: string;
  id: string;
  kind: MarkerKind;
  year: number;
  startDate: string;
  icon: string;
  badge: string;
  title: string;
  detail: string;
}

export function buildChartMarkers({
  events,
  incomeSources,
  expenses,
  timeline,
  people,
}: {
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  timeline: TimelineRow[];
  people: Person[];
}): ChartMarker[] {
  const timelineById = new Map(timeline.map((t) => [t.eventId, t]));
  const ownerName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "" : "Joint");

  const markers: ChartMarker[] = [];

  for (const ev of events) {
    if (ev.isExcluded) continue;
    markers.push({
      key: `ev-${ev.id}`,
      id: ev.id,
      kind: "event",
      year: Number(ev.startDate.slice(0, 4)),
      startDate: ev.startDate,
      icon: EVENT_TYPE_ICONS[ev.type],
      badge: EVENT_TYPE_LABELS[ev.type] ?? ev.type,
      title: ev.name,
      detail: timelineById.get(ev.id)?.description ?? "",
    });
  }

  for (const inc of incomeSources) {
    if (inc.isExcluded) continue;
    markers.push({
      key: `inc-${inc.id}`,
      id: inc.id,
      kind: "income",
      year: Number(inc.startDate.slice(0, 4)),
      startDate: inc.startDate,
      icon: INCOME_CATEGORY_ICONS[inc.category],
      badge: INCOME_CATEGORY_BADGES[inc.category],
      title: inc.name,
      detail: `${formatMoney(inc.amount)}${freqLabel(inc.frequency, inc.intervalYears)} · ${ownerName(inc.ownerId)}`,
    });
  }

  for (const exp of expenses) {
    if (exp.isExcluded) continue;
    markers.push({
      key: `exp-${exp.id}`,
      id: exp.id,
      kind: "expense",
      year: Number(exp.startDate.slice(0, 4)),
      startDate: exp.startDate,
      icon: EXPENSE_CATEGORY_ICONS[exp.category],
      badge: "Expense",
      title: exp.name,
      detail: `${formatMoney(exp.amount)}${freqLabel(exp.frequency, exp.intervalYears)}`,
    });
  }

  return markers;
}
