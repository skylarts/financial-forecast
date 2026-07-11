"use client";

import { useRef, useState } from "react";
import { usePlanStore } from "@/store/usePlanStore";

// Chromium browsers (Chrome, Edge, Comet, ...) expose this for a native
// "Save As" dialog; Safari/Firefox don't, so we fall back to a plain download.
type SaveFilePicker = (opts: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>;

function backupFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `forecast-plan-backup-${stamp}.json`;
}

export function BackupControls() {
  const plan = usePlanStore((s) => s.plan);
  const importPlan = usePlanStore((s) => s.importPlan);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleExport = async () => {
    const json = JSON.stringify(plan, null, 2);
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: backupFileName(),
          types: [{ description: "JSON backup", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        setMessage("Backup saved.");
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return; // user cancelled the dialog
        // Any other failure (e.g. API present but blocked) falls through to a plain download.
      }
    }

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupFileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMessage("Backup downloaded.");
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file if the user retries
    if (!file) return;

    if (
      !confirm(
        `Import "${file.name}"?\n\nThis replaces ALL data currently in this browser -- every scenario, account, income source, expense, and event -- with what's in the file. This can't be undone.`
      )
    ) {
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());
      // Accept either shape: a plain plan (from the ⬇ Backup button here) or
      // the raw zustand-persist envelope { state: { plan }, version } (from
      // recover.html downloading localStorage's "forecast-plan" value as-is).
      const candidate =
        parsed && typeof parsed === "object" && "state" in parsed && (parsed as { state?: { plan?: unknown } }).state?.plan
          ? (parsed as { state: { plan: unknown } }).state.plan
          : parsed;
      const result = importPlan(candidate);
      setMessage(result.ok ? "Backup restored." : `Import failed: ${result.error}`);
    } catch {
      setMessage("Import failed: not a valid JSON file.");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleExport}
        title="Save everything in this browser (all scenarios) to a file on disk"
        className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
      >
        ⬇ Backup
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        title="Restore from a backup file -- replaces everything in this browser"
        className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
      >
        ⬆ Restore
      </button>
      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportFile} />
      {message && <span className="text-xs text-dim">{message}</span>}
    </div>
  );
}
