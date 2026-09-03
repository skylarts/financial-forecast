/**
 * Reading a set of account ids on the rows that carry one.
 *
 * Which accounts are in play is decided by the account facet in the filter
 * panel (`accountIdsForFacet` in `src/components/portfolio/filters.ts`); this
 * is the other half, applying the ids it resolves to a list of rows.
 */

/**
 * A predicate matching rows in `accountIds`, backed by a Set.
 *
 * The scope is a plain array because that is what every caller wants to hold,
 * but it is asked once per transaction -- so testing it with `includes` made
 * every scoped read of the ledger cost the ledger times the scope. Building
 * the Set once per filter and reusing it across the rows is the whole fix.
 */
export function scopedTo(accountIds: readonly string[]): (row: { accountId: string }) => boolean {
  const ids = new Set(accountIds);
  return (row) => ids.has(row.accountId);
}
