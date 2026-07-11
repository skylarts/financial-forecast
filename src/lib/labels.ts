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
