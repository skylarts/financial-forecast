/**
 * The rule that decides whether a local ledger is allowed to overwrite the
 * cloud copy.
 *
 * Pulled out of the sync hook and given its own tests because it is the last
 * thing standing between a bad load and a destroyed ledger, and because the
 * incident that produced it was not caught by any test of the hook itself.
 *
 * ## What happened
 *
 * A push went out carrying an empty portfolio and flattened a real one. No
 * user action was involved: the local store was empty because that browser had
 * nothing saved and the cloud pull had failed, and the quote-refresh writeback
 * -- which stamps a save every time prices land -- was enough to trigger the
 * push on its own.
 *
 * ## The rule
 *
 * An empty ledger may only be pushed if a non-empty one has been in the store
 * at some point this session. That is exactly the line between the two cases
 * the old code could not tell apart:
 *
 *  - The user really did clear the ledger. It was loaded, so it was seen
 *    non-empty, and the deletion syncs normally.
 *  - The ledger never arrived. Nothing was ever seen, so there is nothing to
 *    sync, and the cloud copy is left alone.
 *
 * The cost of being wrong is deliberately lopsided. A refused push that should
 * have gone through leaves a stale cloud copy the next real edit corrects. A
 * permitted push that should have been refused destroys history that may exist
 * nowhere else.
 */
export function safeToPush(localTransactionCount: number, sessionSawTransactions: boolean): boolean {
  if (localTransactionCount > 0) return true;
  return sessionSawTransactions;
}

/**
 * Whether a cloud portfolio may replace the local one.
 *
 * "Cloud wins" is the right default -- it is what makes a second device pick
 * up the ledger rather than shadow it -- but it was applied unconditionally,
 * including to a cloud copy holding nothing at all. That turns a single bad
 * write into a spreading one: once the cloud row is empty, every device that
 * loads afterwards adopts the emptiness, and the copies that could have
 * restored it are gone before anyone notices.
 *
 * A cloud ledger with no transactions therefore does not overwrite a local one
 * that has them. The local copy stands, and the ordinary push sends it back up,
 * so a device holding real history repairs the cloud instead of being erased by
 * it.
 *
 * This matters immediately after a restore: the cloud row is empty from the
 * incident, the restored backup is sitting in the browser, and the next load
 * would otherwise wipe it before the first push ever went out.
 */
export function shouldAcceptCloudLedger(
  cloudTransactionCount: number,
  localTransactionCount: number,
): boolean {
  if (cloudTransactionCount > 0) return true;
  return localTransactionCount === 0;
}
