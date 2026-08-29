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
 * The token is encrypted before it is written.
 *
 * **A local file.** The single-user development mode, kept because it is what
 * makes the app work on a laptop with no Supabase project at all -- the same
 * reason login is optional everywhere else here. It holds one connection and
 * has no concept of users, so it is only ever reached when nobody is signed
 * in.
 *
 * The mode is chosen by what is configured rather than by a flag, so a
 * deployment cannot accidentally be left in the single-user one.
 */

export interface StoredTokens {
  refreshToken: string;
  /** Epoch ms. Schwab's seven-day expiry is measured from here. */
  obtainedAt: number;
}

const TOKEN_PATH = join(process.cwd(), "data", "schwab-tokens.json");

function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
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
  return { mode: "file", userId: null };
}

/* -------------------------------------------------------------------------- */
/* The local single-user file                                                  */
/* -------------------------------------------------------------------------- */

async function readFileTokens(): Promise<StoredTokens | null> {
  try {
    const parsed = JSON.parse(await readFile(TOKEN_PATH, "utf8")) as Partial<StoredTokens>;
    return typeof parsed.refreshToken === "string" && typeof parsed.obtainedAt === "number"
      ? { refreshToken: parsed.refreshToken, obtainedAt: parsed.obtainedAt }
      : null;
  } catch {
    return null;
  }
}

async function writeFileTokens(tokens: StoredTokens | null): Promise<void> {
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

/* -------------------------------------------------------------------------- */
/* Supabase, per user                                                          */
/* -------------------------------------------------------------------------- */

async function readRow(): Promise<StoredTokens | null> {
  try {
    const supabase = await createClient();
    // No user filter is needed for correctness -- row-level security already
    // restricts this to the caller's own row -- but the database is the thing
    // being trusted here, not this query.
    const { data, error } = await supabase
      .from("schwab_connections")
      .select("refresh_token, obtained_at")
      .maybeSingle();
    if (error || !data) return null;

    const refreshToken = decryptSecret(data.refresh_token as string);
    // A token that will not decrypt is a rotated or wrong key. Treated as no
    // connection, which prompts a fresh sign-in rather than an error nobody
    // can act on.
    if (!refreshToken) return null;

    return { refreshToken, obtainedAt: Date.parse(data.obtained_at as string) };
  } catch {
    return null;
  }
}

async function writeRow(userId: string, tokens: StoredTokens | null): Promise<void> {
  const supabase = await createClient();
  if (tokens === null) {
    await supabase.from("schwab_connections").delete().eq("user_id", userId);
    return;
  }
  await supabase.from("schwab_connections").upsert({
    user_id: userId,
    refresh_token: encryptSecret(tokens.refreshToken),
    obtained_at: new Date(tokens.obtainedAt).toISOString(),
    updated_at: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* The interface everything else uses                                          */
/* -------------------------------------------------------------------------- */

export async function readTokens(): Promise<StoredTokens | null> {
  const { mode } = await storageMode();
  if (mode === "supabase") return readRow();
  if (mode === "file") return readFileTokens();
  return null;
}

/**
 * Stores or clears the connection for whoever is asking.
 *
 * Refuses to write an unencrypted credential to a shared database. Failing the
 * sign-in is the correct outcome there: a connection that silently stored a
 * plaintext brokerage token would be worse than no connection at all.
 */
export async function writeTokens(tokens: StoredTokens | null): Promise<boolean> {
  const { mode, userId } = await storageMode();

  if (mode === "supabase" && userId) {
    if (tokens !== null && !encryptionConfigured()) return false;
    try {
      await writeRow(userId, tokens);
      return true;
    } catch {
      return false;
    }
  }

  if (mode === "file") {
    await writeFileTokens(tokens);
    return true;
  }

  return false;
}
