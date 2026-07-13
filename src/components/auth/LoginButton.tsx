"use client";

import { useAuth } from "@/components/auth/AuthProvider";
import { isSupabaseConfigured } from "@/lib/supabase/client";

export function LoginButton() {
  const { user, loading, signInWithGoogle, signOut } = useAuth();

  if (!isSupabaseConfigured || loading) return null;

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-dim" title={user.email ?? undefined}>
          {user.email}
        </span>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void signInWithGoogle()}
      title="Sign in to save your plan to the cloud and access it from other devices"
      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
    >
      Sign in with Google
    </button>
  );
}
