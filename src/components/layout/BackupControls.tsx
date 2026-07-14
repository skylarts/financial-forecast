"use client";

import { useEffect, useRef, useState } from "react";
import { usePlanStore } from "@/store/usePlanStore";
import { buildLlmExport } from "@/lib/llmExport";

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

export function BackupControls() {
  const plan = usePlanStore((s) => s.plan);
  const importPlan = usePlanStore((s) => s.importPlan);
  const activeScenario = usePlanStore((s) => s.plan.scenarios.find((sc) => sc.id === s.plan.activeScenarioId) ?? s.plan.scenarios[0]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

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

    downloadTextFile(json, backupFileName(), "application/json");
    setMessage("Backup downloaded.");
  };

  const handleLlmExport = () => {
    if (!activeScenario) return;
    const markdown = buildLlmExport(activeScenario);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(markdown, `forecast-llm-export-${stamp}.md`, "text/markdown");
    setMessage("LLM export downloaded.");
    setMenuOpen(false);
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
      setMessage(
        result.ok
          ? result.migrated
            ? "Backup restored (auto-migrated from an older plan format)."
            : "Backup restored."
          : `Import failed: ${result.error}`
      );
    } catch {
      setMessage("Import failed: not a valid JSON file.");
    }
  };

  return (
    <div className="relative flex items-center gap-2" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
      >
        Data ▾
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md border border-border bg-panel py-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              handleExport();
              setMenuOpen(false);
            }}
            title="Save everything in this browser (all scenarios) to a file on disk"
            className="block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
          >
            ⬇ Backup
          </button>
          <button
            type="button"
            onClick={() => {
              fileInputRef.current?.click();
              setMenuOpen(false);
            }}
            title="Restore from a backup file -- replaces everything in this browser"
            className="block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
          >
            ⬆ Restore
          </button>
          <button
            type="button"
            onClick={handleLlmExport}
            title="Download the current scenario as a Markdown file you can hand to an AI chatbot"
            className="block w-full px-3 py-1.5 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
          >
            📄 Export for LLM
          </button>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportFile} />
      {message && <span className="text-xs text-dim">{message}</span>}
    </div>
  );
}
