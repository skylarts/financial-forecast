import type { Account, AccountClass } from "@/domain";

/**
 * The one account-class vocabulary: every table, legend, list and picker
 * names a class the same way and orders classes the same way. Cash first
 * (most liquid), then investment accounts by tax character, then the
 * illiquid assets, then debts.
 */
export const ACCOUNT_CLASS_LABELS: Record<AccountClass, string> = {
  cash: "Cash",
  taxable_investment: "Taxable",
  tax_deferred: "Tax-deferred",
  tax_free: "Tax-free (Roth)",
  hsa: "HSA",
  education_529: "529",
  real_estate: "Real estate",
  other_asset: "Other assets",
  credit_card: "Credit cards",
  loan: "Loans",
  mortgage: "Mortgages",
};

/** @deprecated alias kept for older imports; use ACCOUNT_CLASS_LABELS. */
export const accountClassLabels = ACCOUNT_CLASS_LABELS;

export const ASSET_CLASS_ORDER: AccountClass[] = [
  "cash",
  "taxable_investment",
  "tax_deferred",
  "tax_free",
  "hsa",
  "education_529",
  "real_estate",
  "other_asset",
];

export const LIABILITY_CLASS_ORDER: AccountClass[] = ["credit_card", "loan", "mortgage"];

const CLASS_RANK: Record<AccountClass, number> = Object.fromEntries(
  [...ASSET_CLASS_ORDER, ...LIABILITY_CLASS_ORDER].map((cls, i) => [cls, i])
) as Record<AccountClass, number>;

/** Accounts in display order: by class rank, stable within a class. */
export function sortAccountsForDisplay<T extends Pick<Account, "class">>(list: T[]): T[] {
  return [...list].sort((a, b) => CLASS_RANK[a.class] - CLASS_RANK[b.class]);
}

/**
 * Display groups for the Accounts table. `loan` and `mortgage` share one
 * "Loans" group -- a household with both a car loan and a mortgage gets one
 * subtotal row instead of two nearly identical ones back to back.
 */
export interface AccountClassGroup {
  label: string;
  classes: AccountClass[];
}

export const ASSET_CLASS_GROUPS: AccountClassGroup[] = ASSET_CLASS_ORDER.map((cls) => ({
  label: ACCOUNT_CLASS_LABELS[cls],
  classes: [cls],
}));

export const LIABILITY_CLASS_GROUPS: AccountClassGroup[] = [
  { label: "Credit cards", classes: ["credit_card"] },
  { label: "Loans", classes: ["loan", "mortgage"] },
];
