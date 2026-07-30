"use client";

import { useAuth } from "@/components/auth/AuthProvider";
import { isSupabaseConfigured } from "@/lib/supabase/client";

const menuItemClass =
  "block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground";

// Rendered at the top of the "..." menu: the signed-in email, or a "Sign in"
// action when signed out. Pairs with SignOutMenuItem at the bottom.
export function AccountTopMenuItem({ onClose }: { onClose: () => void }) {
  const { user, loading, signInWithGoogle } = useAuth();

  if (!isSupabaseConfigured || loading) return null;

  if (user) {
    return (
      <div className="px-3 py-2 text-sm text-dim" title={user.email ?? undefined}>
        {user.email}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        void signInWithGoogle();
        onClose();
      }}
      title="Sign in to save your plan to the cloud and access it from other devices"
      className={menuItemClass}
    >
      Sign in with Google
    </button>
  );
}

export function SignOutMenuItem({ onClose }: { onClose: () => void }) {
  const { user, loading, signOut } = useAuth();

  if (!isSupabaseConfigured || loading || !user) return null;

  return (
    <button
      type="button"
      onClick={() => {
        void signOut();
        onClose();
      }}
      className={menuItemClass}
    >
      Sign out
    </button>
  );
}
