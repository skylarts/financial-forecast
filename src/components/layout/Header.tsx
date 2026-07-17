"use client";

import { useState } from "react";
import type { Scenario } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useUiStore } from "@/store/useUiStore";
import { useWizardStore } from "@/store/useWizardStore";
import { AssumptionsDrawer } from "@/components/assumptions/AssumptionsDrawer";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { BackupControls } from "@/components/layout/BackupControls";
import { LoginButton } from "@/components/auth/LoginButton";

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

type CreateMode = "duplicate" | "scratch";

function NewScenarioControl({ scenario }: { scenario: Scenario }) {
  const scenarios = usePlanStore((s) => s.plan.scenarios);
  const duplicateScenario = usePlanStore((s) => s.duplicateScenario);
  const addBlankScenario = usePlanStore((s) => s.addBlankScenario);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<CreateMode | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const reset = () => {
    setMenuOpen(false);
    setMode(null);
    setSourceId(null);
    setNewName("");
  };

  const commit = (finalMode: CreateMode, finalSourceId: string | null) => {
    if (!newName.trim()) return reset();
    if (finalMode === "duplicate") duplicateScenario(finalSourceId ?? scenario.id, newName.trim());
    else addBlankScenario(newName.trim());
    reset();
  };

  // Step 2: naming input, once a mode (and source, if needed) is chosen.
  if (mode) {
    return (
      <input
        autoFocus
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onBlur={() => commit(mode, sourceId)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder="Scenario name"
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none"
      />
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-foreground"
      >
        + New Scenario
      </button>
      {menuOpen && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-panel p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              if (scenarios.length > 1) {
                setSourceId(scenario.id);
              } else {
                setMode("duplicate");
              }
            }}
            className="block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-accent/15 hover:text-foreground"
          >
            Duplicate existing plan
          </button>
          <button
            type="button"
            onClick={() => setMode("scratch")}
            className="block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-accent/15 hover:text-foreground"
          >
            Start from scratch
          </button>
          {sourceId !== null && (
            <div className="mt-1 border-t border-border pt-1">
              <div className="px-3 pb-1 pt-2 text-xs text-dim">Duplicate which scenario?</div>
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSourceId(s.id);
                    setMode("duplicate");
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-accent/15 hover:text-foreground"
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Header({ scenario }: { scenario: Scenario }) {
  const scenarios = usePlanStore((s) => s.plan.scenarios);
  const lastSavedAt = usePlanStore((s) => s.lastSavedAt);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const isPink = useUiStore((s) => s.theme) === "pink";
  const openWizard = useWizardStore((s) => s.openWizard);

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
          <NewScenarioControl scenario={scenario} />
        </nav>
        <BackupControls />
        <LoginButton />
        <button
          type="button"
          onClick={openWizard}
          className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-dim hover:text-foreground"
        >
          🧭 Setup Guide
        </button>
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
