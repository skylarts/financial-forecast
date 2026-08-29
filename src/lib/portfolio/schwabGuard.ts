import { storageMode } from "./schwabTokenStore";

/**
 * Who is allowed to reach a Schwab route.
 *
 * Every route that can read a brokerage -- transactions, accounts, and the
 * sign-in that mints the credential -- goes through here. The rule is short:
 * on a deployment you must be signed in, and you only ever reach your own
 * connection.
 *
 * Without this the routes asked nothing at all about the caller. On a laptop
 * that is fine, because only the person at the keyboard can reach localhost.
 * Deployed it is not: `/api/schwab/transactions` would have returned a
 * stranger's full trading history to anyone who visited the URL, no skill
 * required. That is the single thing standing between this being a personal
 * tool and being safe to host.
 *
 * The single-user file mode stays open on purpose, and only when Supabase is
 * not configured at all -- the same condition under which login does not
 * exist in this app either. As soon as there is a Supabase project there is a
 * notion of "whose", and an unauthenticated request has no answer to it.
 */
export type Guard = { ok: true } | { ok: false; response: Response };

export async function requireSchwabAccess(): Promise<Guard> {
  const { mode } = await storageMode();
  if (mode === "supabase" || mode === "file") return { ok: true };

  return {
    ok: false,
    response: Response.json(
      { error: "sign_in_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    ),
  };
}
