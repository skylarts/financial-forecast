import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * OAuth against Schwab's developer platform, shared by every Schwab-backed
 * feature.
 *
 * Server-only. The app secret and both tokens live here and must never reach a
 * client bundle -- every caller is a route handler or the price feed, which is
 * itself only reachable through one.
 *
 * The shape of this file is dictated by one constraint that cannot be
 * engineered around: **Schwab's refresh token expires after seven days and
 * cannot be renewed programmatically.** The only way to get a new one is for a
 * human to log in at Schwab and approve the app again. So this module treats
 * disconnection as a normal resting state rather than an error -- everything
 * degrades to "Schwab is not available right now", and the feeds fall back to
 * Yahoo instead of failing.
 */

const AUTH_BASE = "https://api.schwabapi.com/v1/oauth";

/** Access tokens last 30 minutes; refresh a little early to avoid a race. */
const ACCESS_TOKEN_TTL_MS = 25 * 60 * 1000;

/** Schwab's fixed refresh-token lifetime. Not configurable, not extendable. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the refresh token is kept.
 *
 * A file rather than an env var because the token rotates on a weekly cycle
 * and an env var would mean editing `.env.local` and restarting the server
 * every time. Under `data/`, which is already gitignored for exactly this
 * class of secret.
 */
const TOKEN_PATH = join(process.cwd(), "data", "schwab-tokens.json");

interface StoredTokens {
  refreshToken: string;
  /** Epoch ms, used to tell the user when they will next have to re-approve. */
  obtainedAt: number;
}

export interface SchwabStatus {
  /** App key and secret are present -- the integration is installed. */
  configured: boolean;
  /** A refresh token is on hand and has not aged out. */
  connected: boolean;
  /** ISO timestamp the refresh token dies, or null when not connected. */
  expiresAt: string | null;
  /** Whole days left before a re-login is required, floored at 0. */
  daysRemaining: number | null;
}

function appKey(): string {
  return process.env.SCHWAB_APP_KEY ?? "";
}

function appSecret(): string {
  return process.env.SCHWAB_APP_SECRET ?? "";
}

/**
 * The redirect Schwab sends the browser back to. Must match the callback URL
 * registered on the app at developer.schwab.com character for character, and
 * Schwab only accepts https -- for local work that means
 * `next dev --experimental-https` and a `https://127.0.0.1:3001` callback.
 */
export function callbackUrl(): string {
  return process.env.SCHWAB_CALLBACK_URL ?? "https://127.0.0.1:3001/api/schwab/callback";
}

export function schwabConfigured(): boolean {
  return appKey() !== "" && appSecret() !== "";
}

/* -------------------------------------------------------------------------- */
/* Token storage                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The stored token, cached in process.
 *
 * `undefined` means "not read from disk yet"; `null` means "read, and there is
 * nothing there". Without that distinction every unconnected install would hit
 * the filesystem on every quote.
 */
let stored: StoredTokens | null | undefined;

async function readStored(): Promise<StoredTokens | null> {
  if (stored !== undefined) return stored;
  try {
    const parsed = JSON.parse(await readFile(TOKEN_PATH, "utf8")) as Partial<StoredTokens>;
    stored =
      typeof parsed.refreshToken === "string" && typeof parsed.obtainedAt === "number"
        ? { refreshToken: parsed.refreshToken, obtainedAt: parsed.obtainedAt }
        : null;
  } catch {
    // Missing or unreadable file is the ordinary unconnected case.
    stored = null;
  }
  return stored;
}

async function writeStored(tokens: StoredTokens | null): Promise<void> {
  stored = tokens;
  if (tokens === null) {
    await writeFile(TOKEN_PATH, "", { mode: 0o600 }).catch(() => {});
    return;
  }
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  // Written to a sibling and renamed so a crash mid-write cannot leave a
  // half-written token behind, which would read back as a disconnect and cost
  // the user a re-login they didn't need.
  const temp = `${TOKEN_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(tokens), { mode: 0o600 });
  await rename(temp, TOKEN_PATH);
}

function isLive(tokens: StoredTokens | null): tokens is StoredTokens {
  return tokens !== null && Date.now() - tokens.obtainedAt < REFRESH_TOKEN_TTL_MS;
}

export async function schwabStatus(): Promise<SchwabStatus> {
  const configured = schwabConfigured();
  const tokens = configured ? await readStored() : null;
  if (!isLive(tokens)) {
    return { configured, connected: false, expiresAt: null, daysRemaining: null };
  }
  const expiry = tokens.obtainedAt + REFRESH_TOKEN_TTL_MS;
  return {
    configured,
    connected: true,
    expiresAt: new Date(expiry).toISOString(),
    daysRemaining: Math.max(0, Math.floor((expiry - Date.now()) / (24 * 60 * 60 * 1000))),
  };
}

/** Forgets the stored token, so the next request falls back to Yahoo. */
export async function disconnectSchwab(): Promise<void> {
  accessToken = null;
  await writeStored(null);
}

/* -------------------------------------------------------------------------- */
/* The authorization code flow                                                */
/* -------------------------------------------------------------------------- */

/**
 * Name of the cookie holding the one-time `state` value across the round trip
 * to Schwab. Lives here rather than in the route that sets it because a
 * `route.ts` may only export request handlers.
 */
export const STATE_COOKIE = "schwab_oauth_state";

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: appKey(),
    redirect_uri: callbackUrl(),
    response_type: "code",
    state,
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Schwab authenticates the app itself with HTTP Basic over the key and secret,
 * not with body parameters. Sending them in the body returns a 401 whose body
 * says nothing useful about why.
 */
function basicAuth(): string {
  return `Basic ${Buffer.from(`${appKey()}:${appSecret()}`).toString("base64")}`;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse | null> {
  try {
    const response = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: {
        authorization: basicAuth(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as TokenResponse;
  } catch {
    return null;
  }
}

/**
 * Trades the one-time code from the callback for a token pair and stores the
 * refresh half. Returns false on any failure, which the callback route turns
 * into a "couldn't connect, try again" rather than a stack trace.
 */
export async function exchangeCode(code: string): Promise<boolean> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
  });
  const token = await postToken(body);
  if (!token?.refresh_token) return false;

  await writeStored({ refreshToken: token.refresh_token, obtainedAt: Date.now() });
  if (token.access_token) {
    accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Access tokens                                                              */
/* -------------------------------------------------------------------------- */

let accessToken: { value: string; expiresAt: number } | null = null;
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const tokens = await readStored();
  if (!isLive(tokens)) return null;

  const token = await postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
  );

  if (!token?.access_token) {
    // A refresh that fails inside the seven days is usually the user having
    // revoked the app at Schwab. Drop the stored token so the UI says
    // "disconnected" instead of retrying a dead credential every 30 minutes.
    await writeStored(null);
    return null;
  }

  // Schwab normally hands back the same refresh token, but persist it when it
  // differs so a rotation doesn't silently strand the connection.
  if (token.refresh_token && token.refresh_token !== tokens.refreshToken) {
    await writeStored({ refreshToken: token.refresh_token, obtainedAt: tokens.obtainedAt });
  }

  accessToken = { value: token.access_token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
  return token.access_token;
}

/**
 * A usable access token, or null when Schwab isn't available.
 *
 * Null is not exceptional here: it is the answer for an install that has never
 * connected, one whose seven days have run out, and one whose refresh just
 * failed. Every caller treats it as "use the other feed".
 */
export async function schwabAccessToken(): Promise<string | null> {
  if (!schwabConfigured()) return null;
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.value;

  // A burst of quote requests arriving on a cold token must produce one
  // refresh, not one per symbol -- Schwab rate-limits the token endpoint
  // harder than the data endpoints.
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Test seam: drops in-process caches so a test can start from a clean slate. */
export function resetSchwabAuthCache(): void {
  stored = undefined;
  accessToken = null;
  refreshInFlight = null;
}
