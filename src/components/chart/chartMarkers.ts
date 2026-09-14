import type {
  Account,
  ExpenseBaseline,
  IncomeSource,
  Person,
  RecurrenceFrequency,
  ScenarioEvent,
} from "@/domain";
import { retirementsInOrder } from "@/domain";
import { formatMoney } from "@/lib/format";
import { eventBadgeLabel, EVENT_TYPE_LABELS, INCOME_CATEGORY_BADGES } from "@/lib/timelineFormat";
import { eventIconFor, EVENT_TYPE_ICONS, EXPENSE_CATEGORY_ICONS, INCOME_CATEGORY_ICONS, type MarkerKind } from "./eventIcons";

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
  accounts = [],
}: {
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
  accounts?: Account[];
}): ChartMarker[] {
  const personName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "Someone" : "Joint");
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "an account";

  const markers: ChartMarker[] = [];

  // Retirement is not an event any more, so its milestone is built from the
  // household. It stays the most important marker on the chart.
  for (const { person, date } of retirementsInOrder(people)) {
    const rows: MarkerRow[] = [
      { label: "Start year", value: String(yearOf(date)) },
      { label: "Person", value: person.name },
      { label: "Retirement age", value: String(person.retirementAge) },
    ];
    if (person.retirementSpending?.amount) {
      rows.push({ label: "Extra spending", value: `${formatMoney(person.retirementSpending.amount)}/yr` });
    }
    markers.push({
      key: `retirement-${person.id}`,
      id: `retirement:${person.id}`,
      kind: "event",
      year: yearOf(date),
      startDate: date,
      icon: EVENT_TYPE_ICONS.retirement,
      badge: EVENT_TYPE_LABELS.retirement,
      title: `${person.name} retires`,
      rows,
    });
  }

  for (const ev of events) {
    if (ev.isExcluded) continue;
    const rows: MarkerRow[] = [{ label: "Start year", value: String(yearOf(ev.startDate)) }];
    switch (ev.type) {
      case "buy_home": {
        // Rates/mortgage terms now live on the linked real_estate account
        // (and its own linked mortgage account) -- see BuyHomeEvent.realEstateAccountId.
        const home = accounts.find((a) => a.id === ev.realEstateAccountId);
        const mortgage = home?.linkedLiabilityId ? accounts.find((a) => a.id === home.linkedLiabilityId) : undefined;
        rows.push({ label: "Purchase price", value: formatMoney(ev.purchasePrice) });
        if (mortgage?.loanTerms) {
          rows.push({ label: "Down payment", value: formatMoney(ev.downPaymentAmount) });
          rows.push({ label: "Mortgage term", value: `${Math.round(mortgage.loanTerms.termMonths / 12)} years` });
          rows.push({ label: "Mortgage rate", value: `${(mortgage.loanTerms.annualInterestRatePct * 100).toFixed(2)}%` });
          if (mortgage.loanTerms.extraPrincipalMonthly) {
            rows.push({ label: "Extra principal", value: `${formatMoney(mortgage.loanTerms.extraPrincipalMonthly)}/mo` });
          }
        } else {
          rows.push({ label: "Financing", value: "Paid in cash" });
        }
        if (home?.propertyTaxRatePct) rows.push({ label: "Property tax", value: `${(home.propertyTaxRatePct * 100).toFixed(2)}%/yr` });
        if (home?.homeInsuranceRatePct) rows.push({ label: "Home insurance", value: `${(home.homeInsuranceRatePct * 100).toFixed(2)}%/yr` });
        if (home?.maintenanceRatePct) rows.push({ label: "Maintenance", value: `${(home.maintenanceRatePct * 100).toFixed(2)}%/yr` });
        if (ev.replaceHousingExpenses) rows.push({ label: "Replaces housing expenses", value: "Yes" });
        break;
      }
      case "sell_home":
        rows.push({ label: "Home", value: accountName(ev.realEstateAccountId) });
        rows.push({ label: "Net proceeds", value: formatMoney(ev.netProceeds) });
        break;
      case "roth_conversion":
        rows.push({ label: "From", value: accountName(ev.fromAccountId) });
        rows.push({ label: "To", value: accountName(ev.toAccountId) });
        if (ev.fillToBracketRate != null) rows.push({ label: "Fill to bracket", value: `${Math.round(ev.fillToBracketRate * 100)}%` });
        else if (ev.amount != null) rows.push({ label: ev.frequency === "one_time" ? "Amount" : "Yearly amount", value: formatMoney(ev.amount) });
        if (ev.frequency !== "one_time") rows.push({ label: "End year", value: ev.endDate ? String(yearOf(ev.endDate)) : "Ongoing" });
        rows.push({ label: "Tax paid from", value: ev.taxSource === "withhold" ? "The conversion" : "Cash" });
        break;
      case "open_loan":
        rows.push({ label: "Loan", value: accountName(ev.loanAccountId) });
        rows.push({ label: "Amount borrowed", value: formatMoney(ev.principal) });
        rows.push({
          label: "Money goes to",
          value: ev.proceedsAccountId ? accountName(ev.proceedsAccountId) : "Something outside the plan",
        });
        break;
      case "pay_off_loan":
        rows.push({ label: "Loan", value: accountName(ev.loanAccountId) });
        rows.push({ label: "Paid from", value: accountName(ev.fromAccountId) });
        rows.push({ label: "Amount", value: ev.amount == null ? "Whatever is left" : formatMoney(ev.amount) });
        break;
      case "rollover":
        rows.push({ label: "From", value: accountName(ev.fromAccountId) });
        rows.push({ label: "To", value: accountName(ev.toAccountId) });
        rows.push({ label: "Amount", value: ev.amount == null ? "Whole balance" : formatMoney(ev.amount) });
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
      icon: eventIconFor(ev),
      badge: eventBadgeLabel(ev),
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
