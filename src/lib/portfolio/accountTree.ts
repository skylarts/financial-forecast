import type { PortfolioAccount } from "@/domain/portfolio";

/**
 * Reading a flat account list as the one-level tree `parentAccountId` implies.
 *
 * The tracker stores accounts flat and always has; a sleeve is just an account
 * that names a parent (see `parentAccountId` in `src/domain/portfolio/portfolio.ts`
 * for why the pre-tax/Roth split is modelled that way). Everything here is
 * derived from that one field, so nothing needs to be kept in sync and an
 * account can be re-parented by writing a single value.
 */

/** True when this account is a sleeve of some other account. */
export function isSleeve(account: PortfolioAccount): boolean {
  return account.parentAccountId !== null;
}

/** The sleeves of `parentId`, in the order they appear in the account list. */
export function sleevesOf(
  accounts: readonly PortfolioAccount[],
  parentId: string,
): PortfolioAccount[] {
  return accounts.filter((a) => a.parentAccountId === parentId);
}

/** True when anything names this account as its parent. */
export function hasSleeves(accounts: readonly PortfolioAccount[], id: string): boolean {
  return accounts.some((a) => a.parentAccountId === id);
}

/**
 * The account plus every sleeve under it -- the set of ids whose transactions
 * make up what a user means when they point at this account.
 *
 * A standalone account resolves to just itself, so callers never need to ask
 * whether the split applies before scoping by it.
 */
export function accountFamilyIds(
  accounts: readonly PortfolioAccount[],
  id: string,
): string[] {
  return [id, ...sleevesOf(accounts, id).map((a) => a.id)];
}

/**
 * A sleeve is an accounting subdivision of its parent, not a separate holding:
 * `Texa$aver 401(k)` / `Roth` reads better than repeating the parent's name in
 * every sleeve. Standalone accounts are just their own name.
 */
export function accountPath(
  accounts: readonly PortfolioAccount[],
  account: PortfolioAccount,
): string {
  if (account.parentAccountId === null) return account.name;
  const parent = accounts.find((a) => a.id === account.parentAccountId);
  return parent ? `${parent.name} / ${account.name}` : account.name;
}

export interface AccountTreeRow {
  account: PortfolioAccount;
  /** 0 for a standalone account or a parent, 1 for a sleeve. */
  depth: number;
  /** True when this row is a parent holding sleeves -- it totals them up. */
  isParent: boolean;
}

/**
 * The account list flattened for display: every parent immediately followed by
 * its own sleeves, standalone accounts left where they were.
 *
 * A sleeve whose parent has gone missing is emitted at top level rather than
 * dropped. That state should not arise -- deleting a parent re-parents or
 * removes its sleeves -- but a list that silently omits an account is far
 * worse than one that shows an orphan in an odd place.
 */
export function accountTreeRows(accounts: readonly PortfolioAccount[]): AccountTreeRow[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows: AccountTreeRow[] = [];

  for (const account of accounts) {
    const orphaned = account.parentAccountId !== null && !byId.has(account.parentAccountId);
    if (account.parentAccountId !== null && !orphaned) continue;

    const sleeves = sleevesOf(accounts, account.id);
    rows.push({ account, depth: 0, isParent: sleeves.length > 0 });
    for (const sleeve of sleeves) {
      rows.push({ account: sleeve, depth: 1, isParent: false });
    }
  }

  return rows;
}

/**
 * Why `childId` may not be made a sleeve of `parentId`, or null when it may.
 *
 * The rules exist to keep the tree exactly one level deep, which is what lets
 * every other function here stop at a single hop instead of walking a chain
 * that could loop. Returning the reason rather than throwing lets the UI put
 * it in front of the user, which is the only place it can be acted on.
 */
export function assertAssignableParent(
  accounts: readonly PortfolioAccount[],
  childId: string,
  parentId: string | null,
): string | null {
  if (parentId === null) return null;
  if (parentId === childId) return "An account cannot be a sleeve of itself.";

  const parent = accounts.find((a) => a.id === parentId);
  if (!parent) return "That account no longer exists.";
  if (parent.parentAccountId !== null) {
    return `"${parent.name}" is already a sleeve. Sleeves cannot be nested.`;
  }
  if (hasSleeves(accounts, childId)) {
    const child = accounts.find((a) => a.id === childId);
    return `"${child?.name ?? "This account"}" has sleeves of its own, so it cannot become one.`;
  }
  return null;
}
