import type { AccountClass } from "@/domain";

export const accountClassLabels: Record<AccountClass, string> = {
  cash: "Cash",
  taxable_investment: "Taxable Investments",
  tax_deferred: "Tax-deferred Investments",
  tax_free: "Tax-free Investments",
  real_estate: "Real Estate",
  other_asset: "Other Assets",
  credit_card: "Credit Cards",
  loan: "Loans",
  mortgage: "Loans",
};

export const ASSET_CLASS_ORDER: AccountClass[] = [
  "cash",
  "taxable_investment",
  "tax_deferred",
  "tax_free",
  "real_estate",
  "other_asset",
];

export const LIABILITY_CLASS_ORDER: AccountClass[] = ["credit_card", "loan", "mortgage"];

/**
 * Display groups for the Accounts table. `loan` and `mortgage` share the
 * "Loans" label but are separate account classes -- grouping them here means
 * a household with both a car loan and a mortgage gets one "Loans" subtotal
 * row instead of two identically-labeled ones back to back.
 */
export interface AccountClassGroup {
  label: string;
  classes: AccountClass[];
}

export const ASSET_CLASS_GROUPS: AccountClassGroup[] = ASSET_CLASS_ORDER.map((cls) => ({
  label: accountClassLabels[cls],
  classes: [cls],
}));

export const LIABILITY_CLASS_GROUPS: AccountClassGroup[] = [
  { label: "Credit Cards", classes: ["credit_card"] },
  { label: "Loans", classes: ["loan", "mortgage"] },
];
