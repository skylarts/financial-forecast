import { disconnectSchwab, schwabStatus } from "@/lib/portfolio/schwabAuth";
import { requireSchwabAccess } from "@/lib/portfolio/schwabGuard";

/**
 * Whether Schwab is connected and how long the connection has left.
 *
 * The countdown is the point: the refresh token expires seven days after it
 * was issued no matter how much it is used, so the UI has to be able to tell
 * the user that a re-login is due before prices quietly revert to the
 * fallback feed.
 *
 * Unguarded on purpose. It reports booleans and a date about the caller's own
 * session and never the credential itself, and the signed-out answer --
 * `signInRequired` -- is exactly what the page needs in order to say so.
 */
export async function GET() {
  return Response.json(await schwabStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Forgets the stored token. Prices fall back to the public feed immediately. */
export async function DELETE() {
  // Guarded even though the underlying write is already scoped to the caller:
  // an unauthenticated DELETE has no connection of its own to drop, so the
  // only thing it could ever do is act on somebody else's.
  const guard = await requireSchwabAccess();
  if (!guard.ok) return guard.response;

  await disconnectSchwab();
  return Response.json(await schwabStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
