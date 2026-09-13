/**
 * The rules that decide whether a plan may move between this browser and the
 * cloud. Pure functions, tested on their own, for the same reason the
 * portfolio's `syncSafety.ts` exists: the sync hook is the last thing between
 * a bad load and a destroyed plan, and the incident that produced those rules
 * was not caught by any test of the hook itself.
 *
 * The four rules, carried over from the portfolio side:
 *
 *  1. Never push when the pull failed. A failed pull keeps the local copy and
 *     syncs nothing until a pull succeeds.
 *  2. Never push an empty plan unless this session has seen a non-empty one.
 *  3. Never let a cloud copy with no content overwrite a local copy that has
 *     some.
 *  4. Never destroy a copy before its replacement has been kept somewhere.
 *     (That one lives in the store: every replacement stashes first.)
 */

export type PullOutcome = "not-started" | "in-flight" | "succeeded" | "empty" | "failed";

/**
 * Rule 1 and rule 2 together: whether the local plan may be pushed right now.
 *
 * `pull` is the outcome of this session's cloud read for the signed-in user.
 * "empty" (no row yet) counts as a successful read: the cloud has nothing to
 * lose. "failed" and anything earlier refuse the push.
 */
export function safeToPushPlan(pull: PullOutcome, localHasContent: boolean, sessionSawContent: boolean): boolean {
  if (pull !== "succeeded" && pull !== "empty") return false;
  if (localHasContent) return true;
  return sessionSawContent;
}

/**
 * Rule 3: whether a cloud plan may replace the local one.
 *
 * Cloud wins by default; that is what makes a second device pick the plan
 * up. A cloud plan with no content does not win over a local plan that has
 * some: the local copy stands and the ordinary push repairs the cloud.
 */
export function shouldAcceptCloudPlan(cloudHasContent: boolean, localHasContent: boolean): boolean {
  if (cloudHasContent) return true;
  return !localHasContent;
}

/**
 * Whether a push would overwrite a cloud copy this session has never seen:
 * the row changed (another device, the spouse) since we last read or wrote
 * it. The push still goes ahead, last write wins, but the caller keeps the
 * newer cloud copy first so nothing is lost.
 */
export function cloudChangedSinceSeen(cloudUpdatedAt: string | null, lastSeenUpdatedAt: string | null): boolean {
  if (!cloudUpdatedAt || !lastSeenUpdatedAt) return false;
  return cloudUpdatedAt !== lastSeenUpdatedAt;
}
