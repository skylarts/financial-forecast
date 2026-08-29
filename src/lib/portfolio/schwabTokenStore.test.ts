import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());
// Returns the row so the assertions can read exactly what was sent.
const upsert = vi.hoisted(() =>
  vi.fn(async (row: Record<string, unknown>) => ({ error: null, row })),
);
const maybeSingle = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      // Mirrors the real chain: the query is scoped by user_id before it is
      // resolved, so a test that dropped the filter would fail here too.
      select: () => ({ eq: () => ({ maybeSingle }) }),
      upsert,
      update,
    }),
  }),
}));

const {
  readAppCredentials,
  readTokens,
  storageMode,
  writeAppCredentials,
  writeTokens,
} = await import("./schwabTokenStore");

const KEY = "0".repeat(64);
const signedIn = () => getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
const signedOut = () => getUser.mockResolvedValue({ data: { user: null } });

function withSupabase() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
}

function withoutSupabase() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "schwab-store-"));
  vi.stubEnv("SCHWAB_TOKEN_PATH", join(scratch, "tokens.json"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
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

  it("uses the local file in development where there is no Supabase at all", async () => {
    // The same condition under which this app has no login to begin with.
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "development");
    expect(await storageMode()).toEqual({ mode: "file", userId: null });
  });

  it("locks down rather than opening up when a production build loses its Supabase config", async () => {
    // The failure this exists for: the file mode is unauthenticated by
    // construction and used to be selected by the *absence* of the Supabase
    // variables. A deployment that lost them -- scoped to the wrong
    // environment, a typo, a preview build -- silently became a public
    // /api/schwab/transactions serving a stranger's trading history.
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "production");
    expect(await storageMode()).toEqual({ mode: "none", userId: null });
  });

  it("still allows a deliberate single-user production install", async () => {
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHWAB_ALLOW_SINGLE_USER", "true");
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

    const written = upsert.mock.calls[0]?.[0] as unknown as { refresh_token: string; user_id: string };
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
    const stored = (upsert.mock.calls[0]?.[0] as unknown as { refresh_token: string }).refresh_token;
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

describe("the user's own Schwab application", () => {
  it("encrypts both halves and reads them back", async () => {
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    expect(await writeAppCredentials({ appKey: "my-app-key", appSecret: "my-app-secret" })).toBe(true);

    const written = upsert.mock.calls[0]?.[0] as unknown as Record<string, string>;
    expect(written.app_key).not.toContain("my-app-key");
    expect(written.app_secret).not.toContain("my-app-secret");
    expect(written.app_key.startsWith("v1.")).toBe(true);
    expect(written.app_secret.startsWith("v1.")).toBe(true);

    maybeSingle.mockResolvedValue({
      data: { refresh_token: null, obtained_at: null, app_key: written.app_key, app_secret: written.app_secret },
      error: null,
    });
    expect(await readAppCredentials()).toEqual({ appKey: "my-app-key", appSecret: "my-app-secret" });
  });

  it("drops the token whenever the application changes", async () => {
    // A refresh token only means anything to the app that minted it. Keeping
    // one across an app change leaves a credential every refresh rejects,
    // surfacing as a mysterious disconnection a week early.
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    await writeAppCredentials({ appKey: "new-key", appSecret: "new-secret" });
    const written = upsert.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(written.refresh_token).toBeNull();
    expect(written.obtained_at).toBeNull();
  });

  it("refuses to store an application without an encryption key", async () => {
    withSupabase();
    signedIn();
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "");

    expect(await writeAppCredentials({ appKey: "k", appSecret: "s" })).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("the single-user file", () => {
  it("encrypts the token on disk", async () => {
    // This file used to hold a live brokerage credential in plaintext, and its
    // default location is inside the project directory -- which on the machine
    // this was found on was an iCloud-synced folder.
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    expect(await writeTokens({ refreshToken: "on-disk-secret", obtainedAt: 1_700_000_000_000 })).toBe(true);

    const raw = readFileSync(join(scratch, "tokens.json"), "utf8");
    expect(raw).not.toContain("on-disk-secret");
    expect(await readTokens()).toEqual({
      refreshToken: "on-disk-secret",
      obtainedAt: 1_700_000_000_000,
    });
  });

  it("ignores a token left behind in plaintext", async () => {
    // Including the plaintext this file used to be written in: a credential
    // stored in the clear has to be treated as exposed, and the only safe
    // reading of one is to ignore it and ask for a fresh login.
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(scratch, "tokens.json"),
      JSON.stringify({ refreshToken: "legacy-plaintext", obtainedAt: Date.now() }),
    );

    expect(await readTokens()).toBeNull();
  });

  it("keeps the application when only the connection is dropped", async () => {
    withoutSupabase();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);

    await writeAppCredentials({ appKey: "file-key", appSecret: "file-secret" });
    await writeTokens({ refreshToken: "tok", obtainedAt: Date.now() });
    await writeTokens(null);

    expect(await readTokens()).toBeNull();
    expect(await readAppCredentials()).toEqual({ appKey: "file-key", appSecret: "file-secret" });
  });
});
