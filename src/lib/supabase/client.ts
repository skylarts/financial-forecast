import { createBrowserClient } from "@supabase/ssr";

/** Whether Supabase env vars are configured -- login/cloud sync are optional,
 * so callers should check this before assuming createClient() will work. */
export const isSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
