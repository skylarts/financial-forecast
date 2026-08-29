import { disconnectSchwab, schwabStatus } from "@/lib/portfolio/schwabAuth";

/**
 * Whether Schwab is connected and how long the connection has left.
 *
 * The countdown is the point: the refresh token expires seven days after it
 * was issued no matter how much it is used, so the UI has to be able to tell
 * the user that a re-login is due before prices quietly revert to the
 * fallback feed.
 */
export async function GET() {
  return Response.json(await schwabStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Forgets the stored token. Prices fall back to the public feed immediately. */
export async function DELETE() {
  await disconnectSchwab();
  return Response.json(await schwabStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
