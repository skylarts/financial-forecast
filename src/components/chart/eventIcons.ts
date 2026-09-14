import type { ExpenseCategory, IncomeCategory, TimelineEntryType } from "@/domain";

// Keyed by TimelineEntryType, so the synthesized "retirement" row has an
// icon alongside the real event types.
export const EVENT_TYPE_ICONS: Record<TimelineEntryType, string> = {
  retirement: "🏖️",
  buy_home: "🏠",
  sell_home: "🏷️",
  roth_conversion: "🔄",
  pay_off_loan: "✅",
  open_loan: "🏦",
  refinance: "art:refinance",
  rollover: "📦",
  custom_transfer: "🔁",
};

export const INCOME_CATEGORY_ICONS: Record<IncomeCategory, string> = {
  salary: "💼",
  social_security: "🏛️",
  pension: "🧓",
  rental: "🏘️",
  other: "💰",
};

export const EXPENSE_CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  housing: "🏡",
  transportation: "🚗",
  food: "🍽️",
  healthcare: "⚕️",
  childcare: "🍼",
  discretionary: "🎉",
  other: "💳",
};

export type MarkerKind = "event" | "income" | "expense";

export const MARKER_TONE_CLASS: Record<MarkerKind, string> = {
  income: "bg-positive/25 text-positive",
  expense: "bg-negative/25 text-negative",
  event: "bg-accent/25 text-accent",
};

/** The icon for an event; a HELOC gets its own so it doesn't read as a car loan on the chart. */
export function eventIconFor(event: { type: TimelineEntryType; loanKind?: "fixed" | "heloc"; templateId?: string }): string {
  // The template it was created from is the most specific thing we know --
  // "Buy a car with a loan" and "Take out a student loan" are both open_loan.
  if (event.templateId && TEMPLATE_ICONS[event.templateId]) return TEMPLATE_ICONS[event.templateId];
  if (event.type === "open_loan" && event.loanKind === "heloc") return "🏡";
  return EVENT_TYPE_ICONS[event.type];
}

/**
 * One icon per life-event template (see lib/lifeEventTemplates.ts). A record
 * created from a template remembers which one (`templateId`), so a Wedding
 * can show a ring rather than the generic Discretionary icon it would get
 * from its category alone.
 *
 * Anything prefixed `art:` is drawn rather than an emoji -- see MarkerIcon --
 * because no emoji reads correctly at this size for those four.
 */
export const TEMPLATE_ICONS: Record<string, string> = {
  // Family
  wedding: "💍",
  baby: "👶",
  college: "🎓",
  "support-family": "🤲",
  gift: "🎁",
  // Work & income
  "new-job": "💼",
  bonus: "💵",
  "career-break": "⏸️",
  "part-time": "art:part_time",
  "retirement-work": "🧑‍💻",
  "social-security": "🏛️",
  pension: "🧓",
  "rental-income": "🏘️",
  inheritance: "🕊️",
  // Home
  "buy-home": "🏠",
  "sell-home": "🏷️",
  downsize: "art:downsize",
  refinance: "art:refinance",
  heloc: "🏡",
  renovation: "🔨",
  "rental-property": "🏘️",
  moving: "🚚",
  // Cars & big purchases
  "car-cash": "🚗",
  "car-loan": "art:car_loan",
  "big-purchase": "🛍️",
  travel: "✈️",
  // Health & later life
  retire: "🏖️",
  medicare: "🏥",
  "long-term-care": "🧑‍⚕️",
  medical: "🩺",
  death: "🕯️",
  // Money moves
  roth: "🔄",
  rollover: "📦",
  payoff: "✅",
  loan: "🏦",
  charity: "❤️",
  transfer: "🔁",
};

/** A record's icon: its life-event template's when it has one, else the fallback. */
export function iconForTemplate(templateId: string | undefined, fallback: string): string {
  return (templateId && TEMPLATE_ICONS[templateId]) || fallback;
}
