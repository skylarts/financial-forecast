import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The token lifecycle, which is the part of the Schwab integration a user
 * cannot repair for themselves.
 *
 * Everything here is really one question asked several ways: **what is
 * allowed to destroy a refresh token?** Schwab issues no unattended way to
 * replace one, so throwing a live credential away costs a human a login at
 * schwab.com, and the price feed asks for a token on every cold instance
 * against an endpoint Schwab rate-limits hard. A rule that deletes on any
 * unhappy answer therefore disconnects healthy accounts in the ordinary
 * course of running, which is exactly what it did.
 */

const getUser = vi.hoisted(() => vi.fn());

/**
 * A stand-in for the row, which writes actually change.
 *
 * Stateful rather than a pair of independent spies because the assertions that
 * matter are about what a *later* read sees: a status check after a failed
 * refresh has to be answered from whatever the refresh left behind, which is
 * the whole thing under test.
 */
const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

const maybeSingle = vi.hoisted(() => vi.fn(async () => ({ data: row.current, error: null })));
const update = vi.hoisted(() =>
  vi.fn((patch: Record<string, unknown>) => ({
    eq: vi.fn(async () => {
      if (row.current) Object.assign(row.current, patch);
      return { error: null };
    }),
  })),
);
const upsert = vi.hoisted(() =>
  vi.fn(async (next: Record<string, unknown>) => {
    row.current = { ...(row.current ?? {}), ...next };
    return { error: null };
  }),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update, upsert }),
  }),
}));

const { disconnectSchwab, exchangeCode, resetSchwabAuthCache, schwabAccessToken, schwabStatus } =
  await import("./schwabAuth");
const { encryptSecret } = await import("./schwabCrypto");

/** Whether the stored credential is gone, as a later read would find it. */
function tokenWasDestroyed(): boolean {
  return !row.current?.refresh_token;
}

/** A user with their own app registered and a connection made yesterday. */
function connectedYesterday(): void {
  row.current = {
    app_key: encryptSecret("app-key-123456"),
    app_secret: encryptSecret("app-secret-123456"),
    refresh_token: encryptSecret("live-refresh-token"),
    obtained_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  };
}

function schwabAnswers(init: ResponseInit, body: unknown = {}): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), init)) as never;
}

function schwabIsUnreachable(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("The operation was aborted due to timeout");
  }) as never;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "0".repeat(64));
  vi.stubEnv("SCHWAB_CALLBACK_URL", "https://example.test/api/schwab/callback");
  getUser.mockReset();
  maybeSingle.mockClear();
  update.mockClear();
  upsert.mockClear();
  resetSchwabAuthCache();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  connectedYesterday();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a refresh that Schwab never answered", () => {
  /**
   * The failure that motivated all of this. The token endpoint is shared with
   * the transaction sync and rate-limited per minute, so a portfolio page that
   * refreshes prices on a cold instance can trip this in normal use.
   */
  it("keeps the connection when Schwab rate-limits the refresh", async () => {
    schwabAnswers({ status: 429 }, { error: "rate_limit" });

    expect(await schwabAccessToken()).toBeNull();
    expect(tokenWasDestroyed()).toBe(false);
  });

  it("keeps the connection when Schwab returns a server error", async () => {
    schwabAnswers({ status: 503 });

    expect(await schwabAccessToken()).toBeNull();
    expect(tokenWasDestroyed()).toBe(false);
  });

  it("keeps the connection when the request times out", async () => {
    schwabIsUnreachable();

    expect(await schwabAccessToken()).toBeNull();
    expect(tokenWasDestroyed()).toBe(false);
  });

  /**
   * A 401 is Schwab rejecting the *application's* key and secret over HTTP
   * Basic. It is not a verdict on the refresh token, and the repair is to fix
   * the app registration -- which the user still has a connection to repair.
   */
  it("keeps the connection when the app credentials are rejected", async () => {
    schwabAnswers({ status: 401 }, { error: "invalid_client" });

    expect(await schwabAccessToken()).toBeNull();
    expect(tokenWasDestroyed()).toBe(false);
  });

  it("still reports the connection as live afterwards, so nothing asks for a re-login", async () => {
    schwabAnswers({ status: 429 });
    await schwabAccessToken();

    expect(await schwabStatus()).toMatchObject({ configured: true, connected: true });
  });
});

describe("a refresh Schwab refused", () => {
  /**
   * `invalid_grant` on a 400 is OAuth 2.0's "this grant is expired or
   * revoked". Keeping the credential after that would leave the UI claiming a
   * connection that can never produce a price again.
   */
  it("drops the connection when Schwab rejects the refresh token", async () => {
    schwabAnswers({ status: 400 }, { error: "invalid_grant" });

    expect(await schwabAccessToken()).toBeNull();
    expect(tokenWasDestroyed()).toBe(true);
  });
});

describe("a refresh that worked", () => {
  it("returns the access token and leaves the stored credential alone", async () => {
    schwabAnswers({ status: 200 }, { access_token: "fresh-access-token" });

    expect(await schwabAccessToken()).toBe("fresh-access-token");
    expect(tokenWasDestroyed()).toBe(false);
  });

  it("persists a rotated refresh token rather than stranding the connection", async () => {
    schwabAnswers({ status: 200 }, {
      access_token: "fresh-access-token",
      refresh_token: "rotated-refresh-token",
    });

    await schwabAccessToken();

    expect(upsert).toHaveBeenCalled();
    expect(tokenWasDestroyed()).toBe(false);
  });
});

describe("the access token is shared across server instances", () => {
  /**
   * The failure this exists to stop. A process-local cache is per instance,
   * and serverless instances are made and thrown away constantly -- so
   * "cached for 25 minutes" meant "fetched again on every cold start",
   * against the endpoint Schwab rate-limits hardest. The account went quiet a
   * few minutes after connecting while its refresh token was perfectly fine.
   */
  it("a cold instance reuses the stored token instead of calling Schwab", async () => {
    schwabAnswers({ status: 200 }, { access_token: "minted-once" });
    expect(await schwabAccessToken()).toBe("minted-once");
    const callsToMintIt = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // A different instance: no process memory, same database row.
    resetSchwabAuthCache();

    expect(await schwabAccessToken()).toBe("minted-once");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsToMintIt);
  });

  it("mints a new one once the stored token has expired", async () => {
    schwabAnswers({ status: 200 }, { access_token: "first" });
    await schwabAccessToken();

    // Age the stored token past its expiry.
    row.current!.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    resetSchwabAuthCache();

    schwabAnswers({ status: 200 }, { access_token: "second" });
    expect(await schwabAccessToken()).toBe("second");
  });

  it("does not leave a usable token behind after disconnecting", async () => {
    schwabAnswers({ status: 200 }, { access_token: "minted-once" });
    await schwabAccessToken();

    await disconnectSchwab();
    resetSchwabAuthCache();

    expect(row.current?.access_token ?? null).toBeNull();
  });
});

describe("what the status route reports", () => {
  it("separates 'signed in' from 'Schwab is answering'", async () => {
    schwabAnswers({ status: 429 });

    // The credential is on file and inside its seven days, so the connection
    // is real -- but nothing can be fetched with it right now, and saying only
    // "connected" is what put "● Schwab" above "no connected accounts".
    expect(await schwabStatus()).toMatchObject({ connected: true, reachable: false });
  });

  it("reports both when Schwab is answering", async () => {
    schwabAnswers({ status: 200 }, { access_token: "fresh" });

    expect(await schwabStatus()).toMatchObject({ connected: true, reachable: true });
  });

  it("has nothing to say about reachability when there is no connection", async () => {
    row.current = null;

    expect(await schwabStatus()).toMatchObject({ connected: false, reachable: null });
  });
});

describe("the consent round trip", () => {
  it("stores the credential when Schwab hands one back", async () => {
    schwabAnswers({ status: 200 }, {
      access_token: "access",
      refresh_token: "brand-new-refresh-token",
    });

    expect(await exchangeCode("one-time-code")).toBe(true);
    expect(upsert).toHaveBeenCalled();
  });

  it("reports failure rather than a connection it did not make", async () => {
    schwabAnswers({ status: 400 }, { error: "invalid_grant" });

    expect(await exchangeCode("stale-code")).toBe(false);
  });

  it("reports failure when Schwab could not be reached at all", async () => {
    schwabIsUnreachable();

    expect(await exchangeCode("one-time-code")).toBe(false);
  });
});
