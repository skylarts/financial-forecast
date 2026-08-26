import type { PortfolioAccount } from "@/domain/portfolio";

/**
 * The header account filter's value. A plain account id scopes to one account
 * (kept for back-compat with call sites written before people existed);
 * `"owner:<id>"` and `"owner:joint"` scope to everyone that person or the
 * joint bucket owns; `"all"` is everything.
 */
export const ALL_ACCOUNTS_SCOPE = "all";
export const JOINT_OWNER_SCOPE = "owner:joint";

export function ownerScope(ownerId: string): string {
  return `owner:${ownerId}`;
}

export function accountScope(accountId: string): string {
  return `account:${accountId}`;
}

/**
 * Resolves a scope value to the account ids it covers, or `null` for "every
 * account" -- the same shape `analyzePortfolio`'s `accountIds` option wants,
 * so a person is just the set of accounts they own.
 *
 * A scope that names nothing real (a removed account, a person no longer in
 * the household) resolves to an empty list rather than falling back to "all":
 * silently widening the scope would show data the click didn't ask for.
 */
export function accountIdsInScope(
  accounts: readonly PortfolioAccount[],
  scope: string,
): string[] | null {
  if (scope === ALL_ACCOUNTS_SCOPE) return null;
  if (scope === JOINT_OWNER_SCOPE) {
    return accounts.filter((a) => a.ownerId === null).map((a) => a.id);
  }
  if (scope.startsWith("owner:")) {
    const ownerId = scope.slice("owner:".length);
    return accounts.filter((a) => a.ownerId === ownerId).map((a) => a.id);
  }
  if (scope.startsWith("account:")) {
    const accountId = scope.slice("account:".length);
    return accounts.some((a) => a.id === accountId) ? [accountId] : [];
  }
  // Legacy shape: a bare account id, same as `account:<id>`.
  return accounts.some((a) => a.id === scope) ? [scope] : [];
}
