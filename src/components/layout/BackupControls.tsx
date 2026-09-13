"use client";

import { useEffect, useRef, useState } from "react";
import { usePlanStore } from "@/store/usePlanStore";
import { useSyncStatus } from "@/store/useSyncStatus";
import { useAuth } from "@/components/auth/AuthProvider";
import { buildLlmExport } from "@/lib/llmExport";
import { BACKUP_SCHEMA_REFERENCE } from "@/lib/backupSchemaReference";
import { unwrapPlanEnvelope } from "@/lib/planIO";
import { RecoverDialog } from "./RecoverDialog";

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

function downloadTextFile(text: string, filename: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const itemClass = "block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground";

/**
 * The Data menu: Backup, Restore, Recover a copy, and the two exports.
 * `openRestore` lets the empty first-run state jump straight to the file
 * picker without opening the menu.
 */
export function BackupControls({ restoreRequest }: { restoreRequest?: number } = {}) {
  const plan = usePlanStore((s) => s.plan);
  const importPlan = usePlanStore((s) => s.importPlan);
  const activeScenario = usePlanStore((s) => s.plan.scenarios.find((sc) => sc.id === s.plan.activeScenarioId) ?? s.plan.scenarios[0]);
  const notify = useSyncStatus((s) => s.notify);
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  // The empty state's "Restore from a file" bumps this counter to open the picker.
  useEffect(() => {
    if (restoreRequest) fileInputRef.current?.click();
  }, [restoreRequest]);

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
        notify("Backup saved.", { ttlMs: 5000 });
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return; // user cancelled the dialog
        // Any other failure (e.g. API present but blocked) falls through to a plain download.
      }
    }

    downloadTextFile(json, backupFileName(), "application/json");
    notify("Backup downloaded.", { ttlMs: 5000 });
  };

  const handleLlmExport = () => {
    if (!activeScenario) return;
    const markdown = buildLlmExport(activeScenario);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(markdown, `forecast-llm-export-${stamp}.md`, "text/markdown");
    notify("Export for an AI assistant downloaded.", { ttlMs: 5000 });
    setMenuOpen(false);
  };

  const handleSchemaExport = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(BACKUP_SCHEMA_REFERENCE, `forecast-backup-schema-${stamp}.md`, "text/markdown");
    notify("Backup schema reference downloaded.", { ttlMs: 5000 });
    setMenuOpen(false);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file if the user retries
    if (!file) return;

    const cloudNote = user
      ? "\n\nYou are signed in, so the restored plan also becomes the household's cloud copy on the next change."
      : "";
    if (
      !confirm(
        `Restore "${file.name}"?\n\nThis replaces every scenario, account, income, expense, and event on screen with what is in the file. The plan on screen is kept under Data, Recover first.${cloudNote}`
      )
    ) {
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());
      const result = importPlan(unwrapPlanEnvelope(parsed), `"${file.name}"`);
      if (result.ok) {
        const parts = ["Backup restored."];
        if (result.migrated) parts.push("It was in an older format and was updated.");
        if (result.repairs.length) parts.push(`${result.repairs.length} reference(s) pointed at missing items and were repaired.`);
        notify(parts.join(" "), { ttlMs: 8000 });
      } else {
        notify(`Restore failed: ${result.error}`);
      }
    } catch {
      notify("Restore failed: that file is not valid JSON.");
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
      >
        Data
        <span className="text-dim">▾</span>
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 w-60 rounded-md border border-border bg-panel py-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              handleExport();
              setMenuOpen(false);
            }}
            title="Save everything on screen (all scenarios) to a file on disk"
            className={itemClass}
          >
            ⬇ Backup to a file
          </button>
          <button
            type="button"
            onClick={() => {
              fileInputRef.current?.click();
              setMenuOpen(false);
            }}
            title="Replace everything with a backup file; the current plan is kept as a copy first"
            className={itemClass}
          >
            ⬆ Restore from a file
          </button>
          <button
            type="button"
            onClick={() => {
              setRecoverOpen(true);
              setMenuOpen(false);
            }}
            title="Copies the app kept before deletes and replacements"
            className={itemClass}
          >
            ↺ Recover a copy…
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={handleLlmExport}
            title="Download the current scenario as a Markdown file you can hand to an AI assistant"
            className={itemClass}
          >
            📄 Export for an AI assistant
          </button>
          <button
            type="button"
            onClick={handleSchemaExport}
            title="The backup file's exact JSON format, so an assistant can write or edit a valid backup"
            className={itemClass}
          >
            📋 Backup format reference
          </button>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportFile} />
      <RecoverDialog open={recoverOpen} onClose={() => setRecoverOpen(false)} />
    </div>
  );
}
