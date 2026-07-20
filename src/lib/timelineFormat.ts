import type { EventType, IncomeCategory } from "@/domain";

export const FREQUENCY_LABELS: Record<string, string> = {
  monthly: "/mo",
  biweekly: "/2wk",
  weekly: "/wk",
  annual: "/yr",
  one_time: " one-time",
};

// A plain "salary" income row just shows the generic Income badge; anything
// else (Social Security, pension, rental, ...) shows its category instead,
// so those stay visually distinct now that they're not separate event types.
export const INCOME_CATEGORY_BADGES: Record<IncomeCategory, string> = {
  salary: "Income",
  social_security: "Social Security",
  pension: "Pension",
  rental: "Rental",
  other: "Income",
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  retire: "Retire",
  buy_home: "Buy a home",
  sell_home: "Sell a home",
  have_a_kid: "Have a kid",
  custom_transfer: "Transfer",
};

export function freqLabel(frequency: string, intervalYears?: number): string {
  if (intervalYears) return ` every ${intervalYears} yr${intervalYears === 1 ? "" : "s"}`;
  return FREQUENCY_LABELS[frequency] ?? "";
}
