import type { EventType, ExpenseCategory, IncomeCategory } from "@/domain";

export const EVENT_TYPE_ICONS: Record<EventType, string> = {
  retire: "🏖️",
  buy_home: "🏠",
  have_a_kid: "👶",
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
