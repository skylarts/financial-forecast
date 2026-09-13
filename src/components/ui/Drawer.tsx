"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useModalDialog } from "./useModalDialog";

/**
 * What a form inside the drawer can ask of it: close, going through the
 * unsaved-changes check when the drawer was told the form is dirty.
 */
interface DrawerApi {
  requestClose: () => void;
}

const DrawerContext = createContext<DrawerApi>({ requestClose: () => {} });

/** The drawer's close request, for a footer's Cancel button. */
export function useDrawer(): DrawerApi {
  return useContext(DrawerContext);
}

export function Drawer({
  open,
  title,
  onClose,
  dirty = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /**
   * True while the form inside has unsaved edits. Escape, the backdrop, the
   * ✕ and Cancel then ask before discarding instead of throwing the edits
   * away -- a stray click used to lose a half-built account.
   */
  dirty?: boolean;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <OpenDrawer title={title} onClose={onClose} dirty={dirty}>
      {children}
    </OpenDrawer>
  );
}

/**
 * Split from `Drawer` so the dialog hook only ever runs while the drawer is
 * actually open -- it moves focus on mount and restores it on unmount, and a
 * closed drawer must do neither.
 */
function OpenDrawer({
  title,
  onClose,
  dirty,
  children,
}: {
  title: string;
  onClose: () => void;
  dirty: boolean;
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirming(true);
    else onClose();
  };
  const box = useModalDialog<HTMLDivElement>(requestClose);
  return (
    <DrawerContext.Provider value={{ requestClose }}>
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/60" onClick={requestClose} />
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
              onClick={requestClose}
              aria-label="Close"
              className="rounded-md px-2 py-1 text-dim hover:bg-background hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {confirming && (
            <div
              role="alertdialog"
              aria-label="Unsaved changes"
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-sm"
            >
              <span>You have unsaved changes.</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setConfirming(false)}
                  className="rounded-md bg-pri px-2.5 py-1 text-xs font-semibold text-pri-fg"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-dim hover:text-foreground"
                >
                  Discard
                </button>
              </span>
            </div>
          )}
          {children}
        </div>
      </div>
    </DrawerContext.Provider>
  );
}
