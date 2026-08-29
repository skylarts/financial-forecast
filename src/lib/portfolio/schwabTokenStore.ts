import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret, encryptionConfigured } from "./schwabCrypto";

/**
 * Where a Schwab connection lives, and whose it is.
 *
 * There are two storage modes and the difference is not a detail: it decides
 * whether this app can be used by more than one person.
 *
 * **Supabase, per user.** The deployed mode. Each row belongs to one account
 * and row-level security enforces that in the database, so a route that
 * forgets to scope its query still cannot return someone else's credential.
 * Everything secret is encrypted before it is written.
 *
 * **A local file.** The single-user development mode, kept because it is what
 * makes the app work on a laptop with no Supabase project at all -- the same
 * reason login is optional everywhere else here. It holds one connection and
 * has no concept of users.
 *
 * The mode is chosen by what is configured rather than by a flag, with one
 * exception that is the whole point of `singleUserAllowed`: the file mode is
 * unauthenticated by construction, so a *production* build is never allowed to
 * land in it by accident. See below.
 */

export interface StoredTokens {
  refreshToken: string;
  /** Epoch ms. Schwab's seven-day expiry is measured from here. */
  obtainedAt: number;
}

/**
 * A Schwab developer application, as registered at developer.schwab.com.
 *
 * Stored per user so that a shared deployment does not run everyone's
 * brokerage through one person's registered app. Both halves are secret: the
 * key alone is enough to start a consent flow in the app's name, and the pair
 * is what signs a token refresh.
 */
export interface StoredApp {
  appKey: string;
  appSecret: string;
}

/**
 * Where the single-user file lives.
 *
 * Overridable because the default sits inside the project directory, and this
 * project's own working copy lives in an iCloud-synced folder -- which would
 * quietly replicate a live brokerage credential to Apple's servers. The
 * contents are encrypted either way, but the key sits in `.env.local` beside
 * it, so keeping the file out of a synced directory is worth the one variable.
 */
function tokenPath(): string {
  return process.env.SCHWAB_TOKEN_PATH || join(process.cwd(), "data", "schwab-tokens.json");
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Whether the unauthenticated single-user file mode may be used at all.
 *
 * This exists because the previous rule failed open. The mode was selected by
 * the *absence* of the Supabase variables, and `requireSchwabAccess` lets the
 * file mode through without asking who is calling -- correct on a laptop,
 * where only the person at the keyboard can reach localhost. So a deployment
 * that lost those variables (scoped to the wrong environment, a typo, a
 * preview build that never got them) did not fail to start. It silently became
 * a public `/api/schwab/transactions` serving a stranger's trading history.
 *
 * Security must not depend on a variable being present. In a production build
 * the file mode now has to be asked for by name.
 */
function singleUserAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.SCHWAB_ALLOW_SINGLE_USER === "true";
}

/**
 * The signed-in user's id, or null when nobody is signed in.
 *
 * Returns null rather than throwing outside a request, which is what lets the
 * price feed ask for a token from contexts that have no cookies to read.
 */
async function currentUserId(): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Which storage a request will actually use.
 *
 * `none` is a real answer, not an error: a deployment with Supabase configured
 * and nobody signed in has nowhere legitimate to read a credential from, and
 * must not quietly fall back to the single-user file -- that file would be one
 * shared brokerage connection handed to every visitor.
 */
export type StorageMode = "supabase" | "file" | "none";

export async function storageMode(): Promise<{ mode: StorageMode; userId: string | null }> {
  const userId = await currentUserId();
  if (userId) return { mode: "supabase", userId };
  if (supabaseConfigured()) return { mode: "none", userId: null };
  if (singleUserAllowed()) return { mode: "file", userId: null };
  return { mode: "none", userId: null };
}

/* -------------------------------------------------------------------------- */
/* The local single-user file                                                  */
/* -------------------------------------------------------------------------- */

interface FileContents {
  /** Encrypted. Absent when the app credentials are saved but nothing is connected. */
  refreshToken?: string;
  obtainedAt?: number;
  /** Encrypted. Absent when this install uses the deployment's own app. */
  appKey?: string;
  appSecret?: string;
}

async function readFileContents(): Promise<FileContents | null> {
  try {
    return JSON.parse(await readFile(tokenPath(), "utf8")) as FileContents;
  } catch {
    return null;
  }
}

/**
 * Rewrites the file with one field group replaced.
 *
 * Read-modify-write rather than two files, because the app credentials and the
 * token they minted belong together: losing one and keeping the other leaves a
 * connection that cannot be refreshed and cannot say why.
 */
async function updateFileContents(patch: Partial<FileContents>, clear: (keyof FileContents)[]): Promise<void> {
  const next: FileContents = { ...(await readFileContents()), ...patch };
  for (const field of clear) delete next[field];

  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true });
  // Written to a sibling and renamed so a crash mid-write cannot leave a
  // half-written token behind, which would read back as a disconnect and cost
  // the user a re-login they didn't need.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await rename(temp, path);
}

/* -------------------------------------------------------------------------- */
/* Supabase, per user                                                          */
/* -------------------------------------------------------------------------- */

interface ConnectionRow {
  refresh_token: string | null;
  obtained_at: string | null;
  app_key: string | null;
  app_secret: string | null;
}

async function readRow(userId: string): Promise<ConnectionRow | null> {
  try {
    const supabase = await createClient();
    // Row-level security already restricts this to the caller's own row, and
    // it is the thing actually being trusted. The filter is here anyway: it
    // costs nothing, and it means a policy that gets dropped or a migration
    // that lands with RLS off degrades to "no connection" rather than to
    // handing back whichever row the database happened to return first.
    const { data, error } = await supabase
      .from("schwab_connections")
      .select("refresh_token, obtained_at, app_key, app_secret")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as ConnectionRow;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

export async function readTokens(): Promise<StoredTokens | null> {
  const { mode, userId } = await storageMode();

  if (mode === "supabase" && userId) {
    const row = await readRow(userId);
    if (!row?.refresh_token || !row.obtained_at) return null;
    const refreshToken = decryptSecret(row.refresh_token);
    // A token that will not decrypt is a rotated or wrong key. Treated as no
    // connection, which prompts a fresh sign-in rather than an error nobody
    // can act on.
    if (!refreshToken) return null;
    return { refreshToken, obtainedAt: Date.parse(row.obtained_at) };
  }

  if (mode === "file") {
    const contents = await readFileContents();
    if (!contents?.refreshToken || typeof contents.obtainedAt !== "number") return null;
    // Plaintext is not accepted, including the plaintext this file used to be
    // written in. A token stored in the clear has to be treated as exposed,
    // and the only safe reading of one is to ignore it and ask for a re-login.
    const refreshToken = decryptSecret(contents.refreshToken);
    if (!refreshToken) return null;
    return { refreshToken, obtainedAt: contents.obtainedAt };
  }

  return null;
}

/**
 * Stores or clears the connection for whoever is asking.
 *
 * Refuses to write an unencrypted credential anywhere, the local file
 * included. Failing the sign-in is the correct outcome: a connection that
 * silently stored a plaintext brokerage token would be worse than no
 * connection at all, and Schwab issues no read-only variant -- whoever holds
 * one of these can trade.
 */
export async function writeTokens(tokens: StoredTokens | null): Promise<boolean> {
  const { mode, userId } = await storageMode();

  if (mode === "supabase" && userId) {
    if (tokens !== null && !encryptionConfigured()) return false;
    try {
      const supabase = await createClient();
      if (tokens === null) {
        // Only the token is dropped. The user's own app registration is not a
        // credential to their brokerage and survives a disconnect, so
        // reconnecting does not mean re-entering it.
        await supabase
          .from("schwab_connections")
          .update({ refresh_token: null, obtained_at: null, updated_at: new Date().toISOString() })
          .eq("user_id", userId);
        return true;
      }
      const { error } = await supabase.from("schwab_connections").upsert({
        user_id: userId,
        refresh_token: encryptSecret(tokens.refreshToken),
        obtained_at: new Date(tokens.obtainedAt).toISOString(),
        updated_at: new Date().toISOString(),
      });
      return !error;
    } catch {
      return false;
    }
  }

  if (mode === "file") {
    if (tokens === null) {
      await updateFileContents({}, ["refreshToken", "obtainedAt"]).catch(() => {});
      return true;
    }
    if (!encryptionConfigured()) return false;
    try {
      await updateFileContents(
        { refreshToken: encryptSecret(tokens.refreshToken), obtainedAt: tokens.obtainedAt },
        [],
      );
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Per-user app credentials                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own Schwab application, or null when they have not registered
 * one and the deployment's app is to be used instead.
 */
export async function readAppCredentials(): Promise<StoredApp | null> {
  const { mode, userId } = await storageMode();

  if (mode === "supabase" && userId) {
    const row = await readRow(userId);
    if (!row?.app_key || !row.app_secret) return null;
    const appKey = decryptSecret(row.app_key);
    const appSecret = decryptSecret(row.app_secret);
    if (!appKey || !appSecret) return null;
    return { appKey, appSecret };
  }

  if (mode === "file") {
    const contents = await readFileContents();
    if (!contents?.appKey || !contents.appSecret) return null;
    const appKey = decryptSecret(contents.appKey);
    const appSecret = decryptSecret(contents.appSecret);
    if (!appKey || !appSecret) return null;
    return { appKey, appSecret };
  }

  return null;
}

/**
 * Saves or forgets the caller's own Schwab application.
 *
 * Clearing it also clears the token, and that is not tidiness: a refresh token
 * is only meaningful to the application that minted it. Keeping one across an
 * app change would leave a credential that every refresh rejects, reported as
 * a mysterious disconnection a week early.
 */
export async function writeAppCredentials(app: StoredApp | null): Promise<boolean> {
  const { mode, userId } = await storageMode();

  if (mode === "supabase" && userId) {
    if (app !== null && !encryptionConfigured()) return false;
    try {
      const supabase = await createClient();
      const { error } = await supabase.from("schwab_connections").upsert({
        user_id: userId,
        app_key: app === null ? null : encryptSecret(app.appKey),
        app_secret: app === null ? null : encryptSecret(app.appSecret),
        refresh_token: null,
        obtained_at: null,
        updated_at: new Date().toISOString(),
      });
      return !error;
    } catch {
      return false;
    }
  }

  if (mode === "file") {
    if (app === null) {
      await updateFileContents({}, ["appKey", "appSecret", "refreshToken", "obtainedAt"]).catch(() => {});
      return true;
    }
    if (!encryptionConfigured()) return false;
    try {
      await updateFileContents(
        { appKey: encryptSecret(app.appKey), appSecret: encryptSecret(app.appSecret) },
        ["refreshToken", "obtainedAt"],
      );
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
