import type {
  ExpenseBaseline,
  IncomeSource,
  Person,
  RecurrenceFrequency,
  ScenarioEvent,
} from "@/domain";
import { formatMoney } from "@/lib/format";
import { EVENT_TYPE_LABELS, INCOME_CATEGORY_BADGES } from "@/lib/timelineFormat";
import { EVENT_TYPE_ICONS, EXPENSE_CATEGORY_ICONS, INCOME_CATEGORY_ICONS, type MarkerKind } from "./eventIcons";

export interface MarkerRow {
  label: string;
  value: string;
}

export interface ChartMarker {
  key: string;
  id: string;
  kind: MarkerKind;
  year: number;
  startDate: string;
  icon: string;
  badge: string;
  title: string;
  /** Label/value pairs shown in the hover tooltip, in display order -- always
   *  spells out the date range for anything recurring (start year, repeat
   *  cadence, end year) rather than just a single starting amount. */
  rows: MarkerRow[];
  /** Set when this marker belongs to the scenario being compared against, not the active one -- greyed out, not draggable. */
  isCompare?: boolean;
  /** Name of the scenario this marker belongs to; only set/shown in comparison mode. */
  scenarioName?: string;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** null = a one-time occurrence, so there's nothing to repeat. */
function repeatLabel(frequency: RecurrenceFrequency, intervalYears?: number): string | null {
  if (intervalYears) return `${intervalYears} year${intervalYears === 1 ? "" : "s"}`;
  switch (frequency) {
    case "monthly":
      return "1 month";
    case "biweekly":
      return "2 weeks";
    case "weekly":
      return "1 week";
    case "annual":
      return "1 year";
    case "one_time":
      return null;
  }
}

function amountLabel(frequency: RecurrenceFrequency, noun: "income" | "expense" | "transfer"): string {
  const cadence =
    frequency === "monthly"
      ? "Monthly"
      : frequency === "biweekly"
      ? "Biweekly"
      : frequency === "weekly"
      ? "Weekly"
      : frequency === "annual"
      ? "Yearly"
      : "One-time";
  return `${cadence} ${noun} amount`;
}

/** Start year, then (for anything recurring) repeat cadence and end year. */
function recurrenceRows(
  startDate: string,
  frequency: RecurrenceFrequency,
  endDate: string | null | undefined,
  intervalYears: number | undefined
): MarkerRow[] {
  const rows: MarkerRow[] = [{ label: "Start year", value: String(yearOf(startDate)) }];
  const repeat = repeatLabel(frequency, intervalYears);
  if (repeat) {
    rows.push({ label: "Repeat every", value: repeat });
    rows.push({ label: "End year", value: endDate ? String(yearOf(endDate)) : "Ongoing" });
  }
  return rows;
}

export function buildChartMarkers({
  events,
  incomeSources,
  expenses,
  people,
}: {
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
}): ChartMarker[] {
  const personName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "Someone" : "Joint");

  const markers: ChartMarker[] = [];

  for (const ev of events) {
    if (ev.isExcluded) continue;
    const rows: MarkerRow[] = [{ label: "Start year", value: String(yearOf(ev.startDate)) }];
    switch (ev.type) {
      case "retire":
        rows.push({ label: "Person", value: personName(ev.personId) });
        if (ev.retirementAge) rows.push({ label: "Retirement age", value: String(ev.retirementAge) });
        if (ev.retirementExpense) {
          rows.push({ label: "Retirement expense", value: `${formatMoney(ev.retirementExpense.amount)}/yr` });
        }
        break;
      case "buy_home":
        rows.push({ label: "Purchase price", value: formatMoney(ev.purchasePrice) });
        rows.push({ label: "Down payment", value: formatMoney(ev.downPaymentAmount) });
        if (ev.mortgage) {
          rows.push({ label: "Mortgage term", value: `${Math.round(ev.mortgage.termMonths / 12)} years` });
          rows.push({ label: "Mortgage rate", value: `${(ev.mortgage.annualInterestRatePct * 100).toFixed(2)}%` });
        } else {
          rows.push({ label: "Financing", value: "Paid in cash" });
        }
        break;
      case "have_a_kid":
        rows.push({ label: "Repeat every", value: "1 month" });
        rows.push({
          label: "End year",
          value: ev.childcareEndDate ? String(yearOf(ev.childcareEndDate)) : "Ongoing",
        });
        rows.push({ label: "Monthly childcare expense", value: formatMoney(ev.childcareMonthlyExpense) });
        if (ev.additionalOneTimeCost) {
          rows.push({ label: "Upfront child costs", value: formatMoney(ev.additionalOneTimeCost) });
        }
        break;
      case "custom_transfer": {
        const repeat = repeatLabel(ev.frequency, ev.intervalYears);
        if (repeat) {
          rows.push({ label: "Repeat every", value: repeat });
          rows.push({ label: "End year", value: ev.endDate ? String(yearOf(ev.endDate)) : "Ongoing" });
        }
        rows.push({ label: amountLabel(ev.frequency, "transfer"), value: formatMoney(ev.amount) });
        break;
      }
    }
    markers.push({
      key: `ev-${ev.id}`,
      id: ev.id,
      kind: "event",
      year: yearOf(ev.startDate),
      startDate: ev.startDate,
      icon: EVENT_TYPE_ICONS[ev.type],
      badge: EVENT_TYPE_LABELS[ev.type] ?? ev.type,
      title: ev.name,
      rows,
    });
  }

  for (const inc of incomeSources) {
    if (inc.isExcluded) continue;
    const rows = recurrenceRows(inc.startDate, inc.frequency, inc.endDate, inc.intervalYears);
    rows.push({ label: amountLabel(inc.frequency, "income"), value: formatMoney(inc.amount) });
    rows.push({ label: "Owner", value: personName(inc.ownerId) });
    markers.push({
      key: `inc-${inc.id}`,
      id: inc.id,
      kind: "income",
      year: yearOf(inc.startDate),
      startDate: inc.startDate,
      icon: INCOME_CATEGORY_ICONS[inc.category],
      badge: INCOME_CATEGORY_BADGES[inc.category],
      title: inc.name,
      rows,
    });
  }

  for (const exp of expenses) {
    if (exp.isExcluded) continue;
    const rows = recurrenceRows(exp.startDate, exp.frequency, exp.endDate, exp.intervalYears);
    rows.push({ label: amountLabel(exp.frequency, "expense"), value: formatMoney(exp.amount) });
    markers.push({
      key: `exp-${exp.id}`,
      id: exp.id,
      kind: "expense",
      year: yearOf(exp.startDate),
      startDate: exp.startDate,
      icon: EXPENSE_CATEGORY_ICONS[exp.category],
      badge: "Expense",
      title: exp.name,
      rows,
    });
  }

  return markers;
}
