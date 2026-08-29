import { resolveSchwabApp, type AppSource, type ResolvedApp } from "./schwabApp";
import {
  readAccessToken,
  readTokens,
  storageMode,
  writeAccessToken,
  writeTokens,
  type StoredTokens,
} from "./schwabTokenStore";

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
 *
 * Which *application* a flow runs against is not decided here; see
 * `schwabApp`. Every function that talks to Schwab resolves it per caller,
 * because on a shared deployment each person brings their own.
 */

const AUTH_BASE = "https://api.schwabapi.com/v1/oauth";

/** Access tokens last 30 minutes; refresh a little early to avoid a race. */
const ACCESS_TOKEN_TTL_MS = 25 * 60 * 1000;

/**
 * How long to wait on the token endpoint.
 *
 * The consent exchange is generous: a person is watching a redirect and would
 * rather wait than start the whole Schwab login again. A refresh is not --
 * it happens behind an ordinary page load, the fallback price feed is right
 * there, and a slow one held a request open long enough to matter.
 */
const CODE_EXCHANGE_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 8_000;

/** Schwab's fixed refresh-token lifetime. Not configurable, not extendable. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SchwabStatus {
  /** This caller has an application to connect through -- their own or, where
   *  the operator allows it, the deployment's. */
  configured: boolean;
  /** A refresh token is on hand and has not aged out. */
  connected: boolean;
  /**
   * The integration is installed, but this request has no identity to attach
   * a connection to -- Supabase is configured and nobody is signed in.
   *
   * Reported separately from `connected: false` because the two need opposite
   * responses and look identical otherwise: one is "connect Schwab", the other
   * is "sign in first". Without this the app silently reverts to the public
   * price feed and offers a Connect button that cannot succeed.
   */
  signInRequired: boolean;
  /** Whose application the connection runs through, or null when there is none. */
  appSource: AppSource | null;
  /**
   * Whether Schwab will actually answer with the stored credential right now.
   *
   * Reported separately from `connected` because they are different questions
   * and only one of them used to be asked. `connected` means a refresh token
   * is on file and inside its seven days; this means a request made with it
   * would currently succeed. They diverge whenever Schwab is rate-limiting or
   * down, and the gap is what let the header claim "Schwab" while the import
   * panel reported no connected accounts in the same breath.
   *
   * Null when there is no connection to say anything about.
   */
  reachable: boolean | null;
  /** ISO timestamp the refresh token dies, or null when not connected. */
  expiresAt: string | null;
  /** Whole days left before a re-login is required, floored at 0. */
  daysRemaining: number | null;
}

/**
 * The redirect Schwab sends the browser back to. Must match the callback URL
 * registered on the app at developer.schwab.com character for character, and
 * Schwab only accepts https -- for local work that means
 * `next dev --experimental-https` and a `https://127.0.0.1:3001` callback.
 *
 * One address for the whole deployment even when every user brings their own
 * application: each of them registers *this* URL on their own app. It is not
 * a secret and it is the same for everybody, which is what makes the
 * bring-your-own model a form to fill in rather than a redeploy.
 */
export function callbackUrl(): string {
  return process.env.SCHWAB_CALLBACK_URL ?? "https://127.0.0.1:3001/api/schwab/callback";
}

/**
 * Whether Schwab is reachable *in principle* on this install.
 *
 * Deliberately cheap and synchronous: it is called per symbol by the price
 * feed to skip a provider without a request. It cannot tell whether this
 * particular caller has an application, because that is a database read -- so
 * it answers the broader question, and the real gate stays where it has always
 * been, in `schwabAccessToken` returning null and the feed falling back.
 */
/**
 * The origin to send a browser back to after the Schwab round trip.
 *
 * Taken from the registered callback URL rather than from the incoming
 * request, because `new URL(request.url).origin` in Next is ultimately the
 * `Host` header -- something the client sends. Behind a proxy that does not
 * pin it, a forged `Host` turns every redirect in the OAuth flow into a
 * redirect to the attacker's domain. The callback URL is already required to
 * match Schwab's registration character for character, so it is the one origin
 * this app knows to be its own.
 */
export function appOrigin(requestUrl: string): string {
  try {
    return new URL(callbackUrl()).origin;
  } catch {
    return new URL(requestUrl).origin;
  }
}

export function schwabConfigured(): boolean {
  const envApp = Boolean(process.env.SCHWAB_APP_KEY && process.env.SCHWAB_APP_SECRET);
  const perUserPossible = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return envApp || perUserPossible;
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

function isLive(tokens: StoredTokens | null): tokens is StoredTokens {
  return tokens !== null && Date.now() - tokens.obtainedAt < REFRESH_TOKEN_TTL_MS;
}

export async function schwabStatus(): Promise<SchwabStatus> {
  const { mode } = await storageMode();
  const signInRequired = mode === "none";

  const app = signInRequired ? null : await resolveSchwabApp();
  const configured = app !== null;
  const appSource = app?.source ?? null;

  const tokens = configured ? await readTokens() : null;
  if (!isLive(tokens)) {
    return {
      configured,
      connected: false,
      signInRequired,
      appSource,
      reachable: null,
      expiresAt: null,
      daysRemaining: null,
    };
  }

  // Cheap in the ordinary case -- the access token is shared across instances,
  // so this is a read rather than a call to Schwab for all but the first
  // request in each half hour.
  const reachable = (await schwabAccessToken()) !== null;

  const expiry = tokens.obtainedAt + REFRESH_TOKEN_TTL_MS;
  return {
    configured,
    connected: true,
    signInRequired: false,
    appSource,
    reachable,
    expiresAt: new Date(expiry).toISOString(),
    daysRemaining: Math.max(0, Math.floor((expiry - Date.now()) / (24 * 60 * 60 * 1000))),
  };
}

/** Forgets the stored token, so the next request falls back to Yahoo. */
export async function disconnectSchwab(): Promise<void> {
  await forgetAccessToken();
  await writeTokens(null);
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

/** Where to send the browser to consent, or null when there is no app to use. */
export async function authorizeUrl(state: string): Promise<string | null> {
  const app = await resolveSchwabApp();
  if (!app) return null;

  const params = new URLSearchParams({
    client_id: app.appKey,
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
function basicAuth(app: ResolvedApp): string {
  return `Basic ${Buffer.from(`${app.appKey}:${app.appSecret}`).toString("base64")}`;
}

/**
 * What the token endpoint said, in the only three flavours a caller cares
 * about.
 *
 * The distinction between `rejected` and `unavailable` is the whole reason
 * this is not just `TokenResponse | null`. A refresh token is expensive to
 * replace -- Schwab issues no unattended path to a new one, so losing one
 * costs the user a manual login -- and collapsing "Schwab says this credential
 * is dead" together with "Schwab did not answer" is what made a rate limit
 * indistinguishable from a revocation. See `refreshAccessToken`.
 */
type TokenOutcome =
  | { status: "ok"; token: TokenResponse }
  /** Schwab considered the credential and refused it. Nothing to retry. */
  | { status: "rejected" }
  /** No verdict: a timeout, a rate limit, a 5xx, a dropped connection. */
  | { status: "unavailable" };

async function postToken(
  app: ResolvedApp,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<TokenOutcome> {
  let response: Response;
  try {
    response = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: {
        authorization: basicAuth(app),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A throw here is the network, not Schwab: a DNS failure, a reset, or the
    // 15-second timeout above firing. The credential has not been judged.
    return { status: "unavailable" };
  }

  if (response.ok) {
    try {
      return { status: "ok", token: (await response.json()) as TokenResponse };
    } catch {
      // A 200 whose body will not parse is a broken answer, not a verdict.
      return { status: "unavailable" };
    }
  }

  // 400 is what OAuth 2.0 reserves for a grant the server has looked at and
  // refused -- `invalid_grant` for a refresh token that is expired or revoked.
  // That is the one status worth destroying a stored credential over.
  //
  // Everything else is explicitly not: 401 means this app's key and secret
  // were rejected, which says nothing about the refresh token; 429 and 5xx
  // mean Schwab is busy or broken. Treating those as a revocation is what
  // silently disconnected a healthy account mid-session -- the token endpoint
  // is rate-limited harder than the data endpoints, and the price feed calls
  // it on every cold instance.
  return response.status === 400 ? { status: "rejected" } : { status: "unavailable" };
}

/**
 * Trades the one-time code from the callback for a token pair and stores the
 * refresh half. Returns false on any failure, which the callback route turns
 * into a "couldn't connect, try again" rather than a stack trace.
 */
export async function exchangeCode(code: string): Promise<boolean> {
  const app = await resolveSchwabApp();
  if (!app) return false;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
  });
  const outcome = await postToken(app, body, CODE_EXCHANGE_TIMEOUT_MS);
  if (outcome.status !== "ok") return false;

  const refreshToken = outcome.token.refresh_token;
  if (!refreshToken) return false;

  // A refused write is a real failure, not something to paper over: it means
  // there is nowhere safe to put this credential -- no signed-in user, or no
  // encryption key. Reporting success would leave the user believing they had
  // connected something that was never stored.
  const saved = await writeTokens({ refreshToken, obtainedAt: Date.now() });
  if (!saved) return false;

  if (outcome.token.access_token) {
    await cacheAccessToken(outcome.token.access_token);
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Access tokens                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Access tokens, cached per connection rather than per process.
 *
 * The single-token cache this replaced was correct for exactly one user and
 * silently wrong for two: on a deployment it would have handed whoever asked
 * next the token belonging to whoever refreshed last -- one person's browser
 * quietly reading another person's brokerage. Keyed by the owner so that
 * cannot happen, and the same key gates the in-flight refresh.
 */
const accessTokens = new Map<string, { value: string; expiresAt: number }>();
const refreshesInFlight = new Map<string, Promise<string | null>>();

/** Cache key for the current caller, or null when no connection is reachable. */
async function cacheKey(): Promise<string | null> {
  const { mode, userId } = await storageMode();
  if (mode === "supabase" && userId) return `user:${userId}`;
  if (mode === "file") return "local";
  return null;
}

async function cacheAccessToken(value: string): Promise<void> {
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
  const key = await cacheKey();
  if (key) accessTokens.set(key, { value, expiresAt });
  // Written through so the next instance to serve this user does not have to
  // go back to Schwab for a token this one already holds. See
  // `readAccessToken` for why a process-local cache alone is not enough.
  await writeAccessToken({ accessToken: value, expiresAt });
}

/**
 * Drops the caller's cached access token.
 *
 * Called when the connection is torn down and when the application behind it
 * changes. An access token outlives the refresh token it came from by up to
 * half an hour, so without this a user who had just switched apps or
 * disconnected would keep reading their brokerage from a token nothing on
 * disk could account for any more.
 */
export async function forgetAccessToken(): Promise<void> {
  const key = await cacheKey();
  if (key) accessTokens.delete(key);
  await writeAccessToken(null);
}

async function refreshAccessToken(): Promise<string | null> {
  const app = await resolveSchwabApp();
  if (!app) return null;

  const tokens = await readTokens();
  if (!isLive(tokens)) return null;

  const outcome = await postToken(
    app,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
    REFRESH_TIMEOUT_MS,
  );

  // Schwab looked at the credential and refused it -- revoked at Schwab, or
  // aged out early. Drop it so the UI says "disconnected" and asks for a
  // login, instead of retrying a dead credential every 30 minutes.
  if (outcome.status === "rejected") {
    await writeTokens(null);
    return null;
  }

  // No verdict. The connection is still whatever it was: this call falls back
  // to the public price feed and the next one tries again.
  //
  // Deleting here is what the previous version did, and it meant a single
  // rate-limited or timed-out refresh cost the user a manual Schwab login --
  // a week's connection thrown away over one slow request.
  if (outcome.status !== "ok") return null;

  const accessToken = outcome.token.access_token;
  if (!accessToken) return null;

  // Schwab normally hands back the same refresh token, but persist it when it
  // differs so a rotation doesn't silently strand the connection.
  const rotated = outcome.token.refresh_token;
  if (rotated && rotated !== tokens.refreshToken) {
    await writeTokens({ refreshToken: rotated, obtainedAt: tokens.obtainedAt });
  }

  await cacheAccessToken(accessToken);
  return accessToken;
}

/**
 * A usable access token, or null when Schwab isn't available.
 *
 * Null is not exceptional here: it is the answer for an install that has never
 * connected, one whose seven days have run out, and one whose refresh just
 * failed. Every caller treats it as "use the other feed".
 */
export async function schwabAccessToken(): Promise<string | null> {
  const key = await cacheKey();
  // No key means there is no connection this caller may use -- a deployment
  // with nobody signed in. Falling back to any stored token here is exactly
  // the bug that would serve one person's brokerage to another.
  if (!key) return null;

  const cached = accessTokens.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  // Then the shared one. This is the step that keeps a serverless deployment
  // off Schwab's token endpoint: without it every new instance starts cold and
  // mints its own, which is how an account that had just connected began
  // reporting no accounts and no transactions a few minutes later.
  const shared = await readAccessToken();
  if (shared && Date.now() < shared.expiresAt) {
    accessTokens.set(key, { value: shared.accessToken, expiresAt: shared.expiresAt });
    return shared.accessToken;
  }

  // A burst of quote requests arriving on a cold token must produce one
  // refresh, not one per symbol -- Schwab rate-limits the token endpoint
  // harder than the data endpoints. Held per connection so one user's refresh
  // is never awaited by another.
  let inFlight = refreshesInFlight.get(key);
  if (!inFlight) {
    inFlight = refreshAccessToken().finally(() => {
      refreshesInFlight.delete(key);
    });
    refreshesInFlight.set(key, inFlight);
  }
  return inFlight;
}

/** Test seam: drops in-process caches so a test can start from a clean slate. */
export function resetSchwabAuthCache(): void {
  accessTokens.clear();
  refreshesInFlight.clear();
}
