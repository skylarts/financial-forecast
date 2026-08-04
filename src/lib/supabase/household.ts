import { createClient } from "@/lib/supabase/client";

/** Resolves the shared household id for a signed-in user's email, if it's
 * paired with a spouse in the household_members table (set up once via a
 * SQL migration -- see supabase/household_linking.sql). Returns null for an
 * unpaired user, so callers fall back to per-user plan storage. */
export async function getHouseholdId(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const supabase = createClient();
  const { data, error } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error || !data) return null;
  return data.household_id as string;
}
