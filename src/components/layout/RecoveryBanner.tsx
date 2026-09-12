"use client";

import { usePlanStore } from "@/store/usePlanStore";
import { readRecoveryCopy } from "@/lib/planRecovery";

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
 * Says, on screen, what the load had to do. A saved plan that could not be
 * read used to become a console warning and a silent fallback to the sample
 * household; now the person sees it, and the unreadable copy is one click
 * from a file on disk.
 */
export function RecoveryBanner() {
  const issue = usePlanStore((s) => s.loadIssue);
  const clear = usePlanStore((s) => s.clearLoadIssue);
  if (!issue) return null;

  if (issue.kind === "broken") {
    const copy = issue.copyKey ? readRecoveryCopy(issue.copyKey) : null;
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-foreground">
        <div className="font-semibold text-negative">The plan saved in this browser could not be loaded</div>
        <div className="text-dim">{issue.message}</div>
        <div className="text-dim">
          {copy?.raw
            ? "Its contents are kept exactly as they were. Download them to keep a file, or restore an earlier copy from Data, Recover."
            : "No copy could be kept, so this browser has started with an empty plan."}
        </div>
        <div className="flex flex-wrap gap-3">
          {copy?.raw && (
            <button
              type="button"
              onClick={() => downloadText(copy.raw!, `forecast-plan-unreadable-${new Date().toISOString().slice(0, 10)}.json`)}
              className="rounded-md bg-pri px-3 py-1.5 text-xs font-semibold text-pri-fg"
            >
              Download the unreadable copy
            </button>
          )}
          <button type="button" onClick={clear} className="text-xs text-dim hover:text-foreground">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-foreground">
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          {issue.repairs.length === 1 ? "One thing was repaired while loading" : `${issue.repairs.length} things were repaired while loading`}
        </span>
        <button type="button" onClick={clear} className="text-xs text-dim hover:text-foreground">
          Dismiss
        </button>
      </div>
      <ul className="flex flex-col gap-0.5 text-dim">
        {issue.repairs.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}
