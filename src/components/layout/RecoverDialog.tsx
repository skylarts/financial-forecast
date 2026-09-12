"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Btn } from "@/components/ui/controls";
import { usePlanStore } from "@/store/usePlanStore";
import { useSyncStatus } from "@/store/useSyncStatus";
import { deleteRecoveryCopy, listRecoveryCopies, readRecoveryCopy, type RecoveryCopy } from "@/lib/planRecovery";

const KIND_LABELS: Record<RecoveryCopy["kind"], string> = {
  broken: "Could not be loaded",
  replaced: "Replaced",
  snapshot: "Before a delete",
};

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * The copies the app kept for itself, newest first, each with Restore,
 * Download, and Delete. Restoring goes through the same import path as a
 * file, so the plan on screen is kept as a copy first and nothing is lost in
 * either direction.
 */
export function RecoverDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copies, setCopies] = useState<RecoveryCopy[]>(() => listRecoveryCopies());
  const importPlan = usePlanStore((s) => s.importPlan);
  const notify = useSyncStatus((s) => s.notify);

  const refresh = () => setCopies(listRecoveryCopies());

  const restore = (copy: RecoveryCopy) => {
    const stored = readRecoveryCopy(copy.key);
    if (!stored) return;
    const raw = stored.plan ?? (stored.raw ? safeParse(stored.raw) : null);
    if (raw == null) {
      notify("That copy could not be read as JSON. Download it instead.");
      return;
    }
    if (!confirm(`Restore the copy from ${new Date(copy.at).toLocaleString()}?\n\nThe plan on screen is kept as a copy first, and the restored plan is saved to the cloud on the next change if you are signed in.`)) return;
    const result = importPlan(raw, `the copy from ${new Date(copy.at).toLocaleString()}`);
    if (result.ok) {
      notify(result.repairs.length ? `Restored, with ${result.repairs.length} reference(s) repaired.` : "Restored.", { ttlMs: 6000 });
      onClose();
    } else {
      notify(`Could not restore that copy: ${result.error}`);
    }
  };

  return (
    <Drawer open={open} title="Recover a copy" onClose={onClose}>
      <p className="mb-4 text-[12.5px] text-dim">
        Copies this app kept on its own: the plan before anything was deleted, the plan before a cloud copy or a
        restored file replaced it, and any saved plan that could not be loaded. They live in this browser only.
      </p>
      {copies.length === 0 ? (
        <p className="text-sm text-dim">No copies yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {copies.map((c) => (
            <li key={c.key} className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-foreground">{new Date(c.at).toLocaleString()}</span>
                <span className="rounded border border-border px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-dim">
                  {KIND_LABELS[c.kind]}
                </span>
              </div>
              <div className="text-[12px] text-dim">
                {c.reason}
                {c.scenarioCount != null ? ` · ${c.scenarioCount} scenario${c.scenarioCount === 1 ? "" : "s"}` : ""}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {c.kind !== "broken" && (
                  <Btn variant="primary" onClick={() => restore(c)}>
                    Restore
                  </Btn>
                )}
                <Btn
                  onClick={() => {
                    const stored = readRecoveryCopy(c.key);
                    if (!stored) return;
                    const text = stored.raw ?? JSON.stringify(stored.plan, null, 2);
                    downloadText(text, `forecast-plan-copy-${new Date(c.at).toISOString().replace(/[:.]/g, "-")}.json`);
                  }}
                >
                  Download
                </Btn>
                <Btn
                  onClick={() => {
                    if (!confirm("Delete this copy? This cannot be undone.")) return;
                    deleteRecoveryCopy(c.key);
                    refresh();
                  }}
                >
                  Delete
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

function safeParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
