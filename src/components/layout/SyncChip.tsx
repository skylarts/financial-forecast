"use client";

import { useSyncStatus } from "@/store/useSyncStatus";

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * One small chip that says where the plan stands: in this browser only,
 * syncing, synced at a time, or a save that failed and why. It replaces the
 * old static "Saved to this browser" text, which showed even while a cloud
 * save had been failing for an hour.
 */
export function SyncChip() {
  const state = useSyncStatus((s) => s.state);
  const lastSyncedAt = useSyncStatus((s) => s.lastSyncedAt);
  const detail = useSyncStatus((s) => s.detail);

  const label =
    state === "local"
      ? "Saved in this browser"
      : state === "syncing"
        ? "Syncing…"
        : state === "synced"
          ? `Synced${lastSyncedAt ? ` ${timeLabel(lastSyncedAt)}` : ""}`
          : "Cloud save failed";

  const tone =
    state === "error"
      ? "border-negative/50 text-negative"
      : state === "synced"
        ? "border-border text-dim"
        : "border-border text-dim-2";

  return (
    <span
      title={detail ?? (state === "local" ? "Sign in to keep a copy in the cloud and use it on other devices." : undefined)}
      className={`hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] sm:inline ${tone}`}
    >
      {state === "syncing" && <span className="mr-1 inline-block animate-pulse">●</span>}
      {label}
    </span>
  );
}
