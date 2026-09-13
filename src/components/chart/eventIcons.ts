import type { ExpenseCategory, IncomeCategory, TimelineEntryType } from "@/domain";

// Keyed by TimelineEntryType, so the synthesized "retirement" row has an
// icon alongside the real event types.
export const EVENT_TYPE_ICONS: Record<TimelineEntryType, string> = {
  retirement: "🏖️",
  buy_home: "🏠",
  sell_home: "🏷️",
  roth_conversion: "🔄",
  pay_off_loan: "✅",
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
