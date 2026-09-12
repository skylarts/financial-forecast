"use client";

import { useEffect } from "react";
import { usePlanStore } from "@/store/usePlanStore";
import { useSyncStatus } from "@/store/useSyncStatus";

const UNDO_WINDOW_MS = 8000;

/**
 * The stack of short notices in the bottom corner: an Undo after a delete,
 * a word when the cloud replaced or was replaced, a failed save. One place,
 * one style, so nothing else in the app needs its own toast.
 *
 * The Undo notice is derived from the plan store's `pendingUndo` rather than
 * pushed as a notice, so it can never outlive the state it undoes: the store
 * clears it on the next change of any kind, and the toast disappears with it.
 */
export function Notices() {
  const notices = useSyncStatus((s) => s.notices);
  const dismiss = useSyncStatus((s) => s.dismiss);
  const pendingUndo = usePlanStore((s) => s.pendingUndo);
  const undoLastDelete = usePlanStore((s) => s.undoLastDelete);
  const clearPendingUndo = usePlanStore((s) => s.clearPendingUndo);

  // Expire timed notices and the undo window on a slow tick.
  useEffect(() => {
    if (notices.length === 0 && !pendingUndo) return;
    const armedAt = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      for (const n of notices) if (n.expiresAt && n.expiresAt <= now) dismiss(n.id);
      if (pendingUndo && now - armedAt > UNDO_WINDOW_MS) clearPendingUndo();
    }, 1000);
    return () => clearInterval(id);
  }, [notices, pendingUndo, dismiss, clearPendingUndo]);

  if (notices.length === 0 && !pendingUndo) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-40 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:items-end"
    >
      {pendingUndo && (
        <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-md border border-border bg-panel-2 px-3 py-2 text-[12.5px] text-foreground shadow-lg">
          <span>{pendingUndo.label}</span>
          <button
            type="button"
            onClick={undoLastDelete}
            className="rounded px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/15"
          >
            Undo
          </button>
          <button type="button" onClick={clearPendingUndo} aria-label="Dismiss" className="text-dim hover:text-foreground">
            ✕
          </button>
        </div>
      )}
      {notices.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto flex max-w-md items-start gap-3 rounded-md border border-border bg-panel-2 px-3 py-2 text-[12.5px] text-foreground shadow-lg"
        >
          <span className="flex-1">{n.text}</span>
          {n.action && (
            <button
              type="button"
              onClick={() => {
                n.action?.onClick();
                dismiss(n.id);
              }}
              className="rounded px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/15"
            >
              {n.action.label}
            </button>
          )}
          <button type="button" onClick={() => dismiss(n.id)} aria-label="Dismiss" className="text-dim hover:text-foreground">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
