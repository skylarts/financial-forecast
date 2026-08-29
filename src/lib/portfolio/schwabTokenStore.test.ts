import { afterEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const maybeSingle = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({ maybeSingle }),
      upsert,
      delete: del,
    }),
  }),
}));

const { readTokens, storageMode, writeTokens } = await import("./schwabTokenStore");

const KEY = "0".repeat(64);
const signedIn = () => getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
const signedOut = () => getUser.mockResolvedValue({ data: { user: null } });

function withSupabase() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("storage mode", () => {
  it("uses the per-user row when somebody is signed in", async () => {
    withSupabase();
    signedIn();
    expect(await storageMode()).toEqual({ mode: "supabase", userId: "user-1" });
  });

  it("refuses to fall back to the single-user file when signed out", async () => {
    // The bug this forecloses: serving one stored brokerage connection to
    // every anonymous visitor of a deployment.
    withSupabase();
    signedOut();
    expect(await storageMode()).toEqual({ mode: "none", userId: null });
    expect(await readTokens()).toBeNull();
    expect(await writeTokens({ refreshToken: "t", obtainedAt: Date.now() })).toBe(false);
  });

  it("uses the local file only where there is no Supabase at all", async () => {
    // The same condition under which this app has no login to begin with.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(await storageMode()).toEqual({ mode: "file", userId: null });
  });
});

describe("what actually reaches the database", () => {
  it("never writes the token in a form the database can read", async () => {
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    const secret = "schwab-refresh-token-abc123";
    expect(await writeTokens({ refreshToken: secret, obtainedAt: 1_700_000_000_000 })).toBe(true);

    const written = upsert.mock.calls[0][0] as { refresh_token: string; user_id: string };
    expect(written.user_id).toBe("user-1");
    expect(written.refresh_token).not.toContain(secret);
    expect(written.refresh_token.startsWith("v1.")).toBe(true);
  });

  it("refuses to connect rather than storing a plaintext credential", async () => {
    // A silent fallback here is how a live brokerage token ends up readable in
    // a database everyone assumed was encrypted.
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "");

    expect(await writeTokens({ refreshToken: "secret", obtainedAt: Date.now() })).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("reads its own writes back", async () => {
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    await writeTokens({ refreshToken: "round-trip-token", obtainedAt: 1_700_000_000_000 });
    const stored = (upsert.mock.calls[0][0] as { refresh_token: string }).refresh_token;
    maybeSingle.mockResolvedValue({
      data: { refresh_token: stored, obtained_at: "2023-11-14T22:13:20.000Z" },
      error: null,
    });

    expect(await readTokens()).toEqual({
      refreshToken: "round-trip-token",
      obtainedAt: Date.parse("2023-11-14T22:13:20.000Z"),
    });
  });

  it("treats a row it cannot decrypt as no connection", async () => {
    // A rotated key should prompt a fresh sign-in, not an error nobody can act
    // on and not a half-broken connection.
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    maybeSingle.mockResolvedValue({
      data: { refresh_token: "v1.aaa.bbb.ccc", obtained_at: new Date().toISOString() },
      error: null,
    });

    expect(await readTokens()).toBeNull();
  });
});
