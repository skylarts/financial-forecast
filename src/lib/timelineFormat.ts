import type { ScenarioEvent, IncomeCategory, LedgerEvent, TimelineEntryType } from "@/domain";

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

/** The Timeline/chart badge for an event. Mostly the type's label; a HELOC is
 *  an open_loan underneath but reads as its own thing to the person who took it. */
export function eventBadgeLabel(event: Pick<ScenarioEvent, "type"> & { loanKind?: "fixed" | "heloc" }): string {
  if (event.type === "open_loan" && event.loanKind === "heloc") return "HELOC";
  return EVENT_TYPE_LABELS[event.type] ?? event.type;
}

export const EVENT_TYPE_LABELS: Record<TimelineEntryType, string> = {
  retirement: "Retire",
  buy_home: "Buy a home",
  sell_home: "Sell a home",
  roth_conversion: "Roth conversion",
  pay_off_loan: "Pay off loan",
  open_loan: "Take out a loan",
  rollover: "Rollover",
  custom_transfer: "Transfer",
};

/** What the engine's own money movements are called on the Cash Flow tab. */
export const LEDGER_KIND_LABELS: Record<LedgerEvent["kind"], string> = {
  deficit_withdrawal: "Withdrawals to cover spending",
  rmd: "Required distributions (RMDs)",
  surplus_route: "Surplus swept into accounts",
  cap_overflow: "Moved out of a capped account",
  mortgage_payment: "Mortgage payments",
  tax_settlement: "Tax true-up",
  home_sale: "Home sale proceeds",
  roth_conversion: "Roth conversions",
  rollover: "Rollovers",
  shortfall_spill: "Bills an account could not cover",
};

/** The direction of each kind as it affects cash: +1 lands in cash, -1 leaves it (a true-up carries its own sign). */
export const LEDGER_KIND_SIGN: Record<LedgerEvent["kind"], 1 | -1> = {
  deficit_withdrawal: 1,
  rmd: 1,
  surplus_route: -1,
  cap_overflow: 1,
  mortgage_payment: -1,
  tax_settlement: 1,
  home_sale: 1,
  roth_conversion: 1,
  rollover: 1,
  shortfall_spill: -1,
};

export function freqLabel(frequency: string, intervalYears?: number): string {
  if (intervalYears) return ` every ${intervalYears} yr${intervalYears === 1 ? "" : "s"}`;
  return FREQUENCY_LABELS[frequency] ?? "";
}
