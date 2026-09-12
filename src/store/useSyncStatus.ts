import { create } from "zustand";

/**
 * What the sync chip in the view bar shows. Written by useCloudSync and the
 * plan store, read by the chip and the recovery banner. Deliberately not
 * persisted: it describes this session.
 */
export type SyncState =
  /** Signed out, or no cloud configured: the plan lives in this browser only. */
  | "local"
  /** Signed in; reading or writing the cloud row right now. */
  | "syncing"
  /** Signed in; the cloud row matches what is on screen. */
  | "synced"
  /** Signed in; the last read or write failed. Pushes are held. */
  | "error";

export interface Notice {
  id: string;
  /** Short, plain, and specific. */
  text: string;
  /** Optional action, e.g. Undo or Recover. */
  action?: { label: string; onClick: () => void };
  /** Notices without a deadline stay until dismissed. */
  expiresAt?: number;
}

interface SyncStatusState {
  state: SyncState;
  lastSyncedAt: number | null;
  /** One line explaining an error state, for the chip's tooltip and the banner. */
  detail: string | null;
  setSync: (state: SyncState, detail?: string | null) => void;
  markSynced: () => void;

  notices: Notice[];
  notify: (text: string, opts?: { action?: Notice["action"]; ttlMs?: number }) => string;
  dismiss: (id: string) => void;
}

let noticeSeq = 0;

export const useSyncStatus = create<SyncStatusState>((set) => ({
  state: "local",
  lastSyncedAt: null,
  detail: null,
  setSync: (state, detail = null) => set({ state, detail }),
  markSynced: () => set({ state: "synced", detail: null, lastSyncedAt: Date.now() }),

  notices: [],
  notify: (text, opts) => {
    const id = `n${++noticeSeq}`;
    const notice: Notice = {
      id,
      text,
      action: opts?.action,
      expiresAt: opts?.ttlMs ? Date.now() + opts.ttlMs : undefined,
    };
    set((s) => ({ notices: [...s.notices.filter((n) => n.text !== text), notice] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
