import { disconnectSchwab, forgetAccessToken } from "@/lib/portfolio/schwabAuth";
import { resolveSchwabApp, validateAppCredentials } from "@/lib/portfolio/schwabApp";
import { requireSameOrigin, requireSchwabAccess } from "@/lib/portfolio/schwabGuard";
import { encryptionConfigured } from "@/lib/portfolio/schwabCrypto";
import { readAppCredentials, writeAppCredentials } from "@/lib/portfolio/schwabTokenStore";

/**
 * The caller's own Schwab developer application.
 *
 * This is what makes the tool shareable. Schwab has no multi-tenant model --
 * every OAuth flow runs against one registered application, and its owner is
 * accountable for the traffic -- so a second user cannot be added by inviting
 * them, only by letting them bring their own registration. That is this route.
 *
 * The secret goes in and never comes back out. Everything here reports on the
 * application by its key's last four characters, which is enough to tell two
 * registrations apart and useless to anyone who intercepts it.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Which application this caller is using, without disclosing either half. */
export async function GET() {
  const guard = await requireSchwabAccess();
  if (!guard.ok) return guard.response;

  const own = await readAppCredentials();
  const resolved = await resolveSchwabApp();

  return Response.json(
    {
      /** Whether this person has registered their own app. */
      hasOwnApp: own !== null,
      /** "user", "deployment", or null when there is nothing to connect through. */
      appSource: resolved?.source ?? null,
      /** Enough of the key to recognise it by, never the whole thing. */
      appKeyHint: own ? `…${own.appKey.slice(-4)}` : null,
      /** Every user registers this same address on their own Schwab app. */
      callbackUrl: process.env.SCHWAB_CALLBACK_URL ?? null,
      /** Without a key there is nowhere safe to put a secret, so saving is refused. */
      canStore: encryptionConfigured(),
    },
    { headers: NO_STORE },
  );
}

/** Saves the caller's application, replacing any previous one. */
export async function PUT(request: Request) {
  const origin = requireSameOrigin(request);
  if (!origin.ok) return origin.response;

  const guard = await requireSchwabAccess();
  if (!guard.ok) return guard.response;

  if (!encryptionConfigured()) {
    return Response.json({ error: "no_encryption_key" }, { status: 503, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }

  const { appKey, appSecret } = (body ?? {}) as Record<string, unknown>;
  const credentials = validateAppCredentials(appKey, appSecret);
  if (!credentials) {
    return Response.json({ error: "bad_credentials" }, { status: 400, headers: NO_STORE });
  }

  // The old access token was minted by the old application and Schwab will not
  // honour it for the new one. Dropped before the write so a request landing
  // in between cannot pick it back up.
  await forgetAccessToken();

  const saved = await writeAppCredentials(credentials);
  if (!saved) {
    return Response.json({ error: "not_saved" }, { status: 500, headers: NO_STORE });
  }

  // Saving an application always leaves the connection disconnected: a refresh
  // token only means anything to the app that minted it. The user reconnects
  // once, through their own app this time.
  return Response.json(
    { hasOwnApp: true, appKeyHint: `…${credentials.appKey.slice(-4)}`, reconnectRequired: true },
    { headers: NO_STORE },
  );
}

/** Forgets the caller's application and the connection built on it. */
export async function DELETE(request: Request) {
  const origin = requireSameOrigin(request);
  if (!origin.ok) return origin.response;

  const guard = await requireSchwabAccess();
  if (!guard.ok) return guard.response;

  await disconnectSchwab();
  await writeAppCredentials(null);

  return Response.json({ hasOwnApp: false, appKeyHint: null }, { headers: NO_STORE });
}
