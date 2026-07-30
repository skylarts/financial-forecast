import type { Account, AccountClass } from "@/domain";

/** Fixed grouping for "By Account" -- cash first (most liquid), then
 *  investment/retirement accounts by tax treatment, then other assets,
 *  then liabilities last. */
const ACCOUNT_CLASS_ORDER: Record<AccountClass, number> = {
  cash: 0,
  taxable_investment: 1,
  tax_free: 2,
  tax_deferred: 3,
  real_estate: 4,
  other_asset: 5,
  credit_card: 6,
  loan: 7,
  mortgage: 8,
};

export const ACCOUNT_CLASS_LABELS: Record<AccountClass, string> = {
  cash: "Cash",
  taxable_investment: "Taxable",
  tax_free: "Tax-Free",
  tax_deferred: "Tax-Deferred",
  real_estate: "Real Estate",
  other_asset: "Other Assets",
  credit_card: "Credit Cards",
  loan: "Loans",
  mortgage: "Mortgages",
};

export function sortAccountsForDisplay(list: Account[]): Account[] {
  return [...list].sort((a, b) => ACCOUNT_CLASS_ORDER[a.class] - ACCOUNT_CLASS_ORDER[b.class]);
}

/** Splits an already class-sorted account list into consecutive runs of the
 *  same class, for the grouped "By Account" legend. */
export function groupAccountsByClass(list: Account[]): { cls: AccountClass; accounts: Account[] }[] {
  const groups: { cls: AccountClass; accounts: Account[] }[] = [];
  for (const a of list) {
    const last = groups[groups.length - 1];
    if (last && last.cls === a.class) last.accounts.push(a);
    else groups.push({ cls: a.class, accounts: [a] });
  }
  return groups;
}

/** One base hue per account class, so "By Account" reads as a color family
 *  per class (e.g. every blue is cash) with individual accounts as shades
 *  of that hue rather than unrelated colors. */
const ACCOUNT_CLASS_HUE: Record<AccountClass, number> = {
  cash: 212,
  taxable_investment: 152,
  tax_free: 268,
  tax_deferred: 32,
  real_estate: 176,
  other_asset: 48,
  credit_card: 355,
  loan: 15,
  mortgage: 335,
};

/** Evenly spread lightness across a class's accounts so shades stay visually
 *  distinct even with several accounts in the same class; a single account
 *  gets a mid-range shade. Ranges differ per theme since dark backgrounds
 *  need brighter lines and the light joy theme needs darker ones. */
function accountClassColor(hue: number, index: number, count: number, isJoy: boolean): string {
  const saturation = isJoy ? 70 : 72;
  const [minL, maxL] = isJoy ? [32, 56] : [42, 78];
  const t = count <= 1 ? 0.5 : index / (count - 1);
  const lightness = Math.round(maxL - t * (maxL - minL));
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

/**
 * Per-account swatch/line color, keyed by account id.
 *
 * Shared by the chart's "By Account" series and the overview's account
 * snapshot so the same account is the same color in both places — a legend
 * that disagrees with the list beside it is worse than no color at all.
 */
export function buildAccountColors(accounts: Account[], isJoy: boolean): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groupAccountsByClass(accounts)) {
    const hue = ACCOUNT_CLASS_HUE[group.cls];
    group.accounts.forEach((a, i) => {
      map.set(a.id, accountClassColor(hue, i, group.accounts.length, isJoy));
    });
  }
  return map;
}

/** The display-ordered, non-excluded accounts both views colorize. */
export function displayAccounts(allAccounts: Account[]): Account[] {
  return sortAccountsForDisplay(allAccounts.filter((a) => !a.isExcluded));
}
