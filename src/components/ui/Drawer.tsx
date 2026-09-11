"use client";

import type { ReactNode } from "react";
import { useModalDialog } from "./useModalDialog";

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return <OpenDrawer title={title} onClose={onClose}>{children}</OpenDrawer>;
}

/**
 * Split from `Drawer` so the dialog hook only ever runs while the drawer is
 * actually open -- it moves focus on mount and restores it on unmount, and a
 * closed drawer must do neither.
 */
function OpenDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useModalDialog<HTMLDivElement>(onClose);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Full-bleed on a phone (max-w-md only bites once there's room for it).
          The extra bottom padding clears the iPhone home indicator, which
          otherwise sits on top of the last field in a long form. */}
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-panel p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-dim hover:bg-background hover:text-foreground"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
