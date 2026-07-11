"use client";

import { useState } from "react";
import type { Scenario } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useUiStore } from "@/store/useUiStore";
import { AssumptionsDrawer } from "@/components/assumptions/AssumptionsDrawer";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { BackupControls } from "@/components/layout/BackupControls";

function ScenarioTab({ scenario, active }: { scenario: Scenario; active: boolean }) {
  const setActiveScenarioId = usePlanStore((s) => s.setActiveScenarioId);
  const renameScenario = usePlanStore((s) => s.renameScenario);
  const deleteScenario = usePlanStore((s) => s.deleteScenario);
  const scenarioCount = usePlanStore((s) => s.plan.scenarios.length);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(scenario.name);

  if (editing) {
    return (
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (name.trim()) renameScenario(scenario.id, name.trim());
          else setName(scenario.name);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setActiveScenarioId(scenario.id)}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to rename"
      className={`group flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
        active ? "bg-accent text-white" : "text-dim hover:text-foreground"
      }`}
    >
      {scenario.name}
      {scenarioCount > 1 && (
        <span
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete scenario "${scenario.name}"?`)) deleteScenario(scenario.id);
          }}
          className="hidden text-xs opacity-70 hover:opacity-100 group-hover:inline"
        >
          ✕
        </span>
      )}
    </button>
  );
}

export function Header({ scenario }: { scenario: Scenario }) {
  const scenarios = usePlanStore((s) => s.plan.scenarios);
  const duplicateScenario = usePlanStore((s) => s.duplicateScenario);
  const lastSavedAt = usePlanStore((s) => s.lastSavedAt);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const isPink = useUiStore((s) => s.theme) === "pink";

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-4">
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <h1 className="text-xl font-bold">{isPink ? "Forecast ✨" : "Forecast"}</h1>
        {lastSavedAt > 0 && <span className="text-xs text-dim">Saved to this browser</span>}
      </div>
      <div className="flex items-center gap-3">
        <nav className="flex items-center gap-1 rounded-lg border border-border bg-panel p-1">
          {scenarios.map((s) => (
            <ScenarioTab key={s.id} scenario={s} active={s.id === scenario.id} />
          ))}
          {creating ? (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (newName.trim()) duplicateScenario(scenario.id, newName.trim());
                setCreating(false);
                setNewName("");
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              placeholder="Scenario name"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-foreground"
              title={`Duplicate "${scenario.name}" as a new scenario`}
            >
              + New Scenario
            </button>
          )}
        </nav>
        <BackupControls />
        <button
          type="button"
          id="assumptions-button"
          onClick={() => setAssumptionsOpen(true)}
          className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
        >
          ⚙ Assumptions
        </button>
      </div>
      {/* key=scenario.id forces a full remount on scenario switch, so the
          drawer's local form state (settingsDraft, each PersonRow's draft)
          can't go stale relative to whichever scenario is now active. */}
      <AssumptionsDrawer key={scenario.id} open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} scenario={scenario} />
    </header>
  );
}
