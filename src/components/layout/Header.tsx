"use client";

import { useEffect, useRef, useState } from "react";
import type { Scenario } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useUiStore } from "@/store/useUiStore";
import { useWizardStore } from "@/store/useWizardStore";
import { useAssumptionsStore } from "@/store/useAssumptionsStore";
import { AssumptionsDrawer } from "@/components/assumptions/AssumptionsDrawer";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { BackupControls } from "@/components/layout/BackupControls";
import { NavMenuButton } from "@/components/layout/SideNav";
import { AccountTopMenuItem, SignOutMenuItem } from "@/components/auth/LoginButton";
import { Btn } from "@/components/ui/controls";
import { VIEWS, type View } from "@/lib/views";

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
        className="rounded-md border border-border bg-background px-3 py-1.5 text-[12.5px] text-foreground outline-none"
      />
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="rounded-md px-3 py-1.5 text-[12.5px] text-dim hover:text-foreground"
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
            className="block w-full rounded px-3 py-2 text-left text-[12.5px] text-dim hover:bg-accent/15 hover:text-foreground"
          >
            Duplicate existing plan
          </button>
          <button
            type="button"
            onClick={() => setMode("scratch")}
            className="block w-full rounded px-3 py-2 text-left text-[12.5px] text-dim hover:bg-accent/15 hover:text-foreground"
          >
            Start from scratch
          </button>
          {sourceId !== null && (
            <div className="mt-1 border-t border-border pt-1">
              <div className="px-3 pb-1 pt-2 text-[11px] text-dim">Duplicate which scenario?</div>
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSourceId(s.id);
                    setMode("duplicate");
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-[12.5px] text-dim hover:bg-accent/15 hover:text-foreground"
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

// A single button showing the active scenario, opening into a dropdown with
// every other scenario (rename by double-click, delete via the ✕) plus the
// "+ New Scenario" control at the bottom.
function ScenarioSwitcher({ scenario }: { scenario: Scenario }) {
  const scenarios = usePlanStore((s) => s.plan.scenarios);
  const setActiveScenarioId = usePlanStore((s) => s.setActiveScenarioId);
  const renameScenario = usePlanStore((s) => s.renameScenario);
  const deleteScenario = usePlanStore((s) => s.deleteScenario);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  const commitRename = () => {
    if (renamingId && name.trim()) renameScenario(renamingId, name.trim());
    setRenamingId(null);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:border-accent"
      >
        {scenario.name}
        <span className="text-dim">▾</span>
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-panel p-1 shadow-lg">
          {scenarios.map((s) => (
            <div key={s.id} className="group flex items-center gap-1 rounded px-1">
              {renamingId === s.id ? (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="my-0.5 flex-1 rounded bg-pri px-2 py-1.5 text-[12.5px] text-pri-fg outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setActiveScenarioId(s.id);
                    setMenuOpen(false);
                  }}
                  onDoubleClick={() => {
                    setName(s.name);
                    setRenamingId(s.id);
                  }}
                  title="Double-click to rename"
                  className={`flex-1 rounded px-2 py-1.5 text-left text-[12.5px] ${
                    s.id === scenario.id ? "bg-accent/15 font-semibold text-foreground" : "text-dim hover:text-foreground"
                  }`}
                >
                  {s.name}
                </button>
              )}
              {scenarios.length > 1 && renamingId !== s.id && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete scenario "${s.name}"?`)) deleteScenario(s.id);
                  }}
                  className="hidden px-1 text-[11px] text-dim opacity-70 hover:opacity-100 group-hover:inline"
                  title="Delete scenario"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="mt-1 border-t border-border pt-1">
            <NewScenarioControl scenario={scenario} />
          </div>
        </div>
      )}
    </div>
  );
}

// Rare/admin actions (Setup Guide, backup/import/export) tucked behind a
// small overflow menu so the primary bar isn't dominated by low-frequency
// buttons -- Assumptions and scenario switching stay front and center since
// those get used constantly while building out a plan.
function OverflowMenu({ onOpenWizard }: { onOpenWizard: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="More"
        className="rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-dim hover:text-foreground"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-border bg-panel p-1 shadow-lg">
          <AccountTopMenuItem onClose={() => setOpen(false)} />
          <div className="border-t border-border pt-1">
            <ThemeToggle />
          </div>
          <div className="border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                onOpenWizard();
                setOpen(false);
              }}
              className="block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
            >
              Setup Guide
            </button>
          </div>
          <div className="border-t border-border px-1 pt-1">
            <BackupControls />
          </div>
          <div className="border-t border-border pt-1">
            <SignOutMenuItem onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

export function Header({
  scenario,
  view,
  onViewChange,
}: {
  scenario: Scenario;
  view: View;
  onViewChange: (v: View) => void;
}) {
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const openWizard = useWizardStore((s) => s.openWizard);
  const assumptionsOpen = useAssumptionsStore((s) => s.open);
  const openAssumptions = useAssumptionsStore((s) => s.openAssumptions);
  const closeAssumptions = useAssumptionsStore((s) => s.closeAssumptions);

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-border px-3 py-3 sm:px-6 sm:py-3.5">
      {/* The tool's name doubles as the way into the section drawer -- see
          NavMenuButton for why the name, rather than a separate hamburger,
          carries it. */}
      <div className="flex flex-col">
        <h1 className="text-[15px] font-bold leading-tight tracking-tight">
          <NavMenuButton>{isJoy ? "Forecast ✨" : "Forecast"}</NavMenuButton>
        </h1>
        {isJoy && (
          <span className="joy-tagline pl-1 text-[11px] font-medium">Bright days ahead ☀️</span>
        )}
      </div>


      {/* Pinned to the top-right corner at every width. */}
      <div className="flex items-center gap-2">
        <ScenarioSwitcher scenario={scenario} />
        <Btn id="assumptions-button" variant="primary" onClick={openAssumptions} ariaLabel="Assumptions">
          <span aria-hidden>⚙</span>
          <span className="hidden sm:inline"> Assumptions</span>
        </Btn>
        <OverflowMenu onOpenWizard={openWizard} />
      </div>

      {/* The five top-level views, always on their own line beneath the title
          and the action buttons -- at every width, not just narrow ones.

          The top-right corner is the most reachable and most looked-at spot in
          the bar, so it belongs to the controls that act on the plan; a tab
          strip that merely says where you are does not earn it. Making that
          true only below a breakpoint meant the bar rearranged itself as the
          window resized, and in landscape the strip took the corner back and
          pushed the buttons onto a second line. One row of tabs under one row
          of actions is the same shape at every size.

          It's `w-full` (so it always claims its own line) and a scroll strip,
          bled to the screen edge by a negative margin that cancels the header
          gutter -- on a phone the five never fit, and a tab clipped by the
          edge is what tells you there is more to swipe to. */}
      <nav
        className="scroll-strip -mx-3 -mb-3 flex w-full items-center gap-0.5 px-3 sm:-mx-6 sm:-mb-3.5 sm:px-6"
        aria-label="Views"
      >
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-current={v === view}
            onClick={() => onViewChange(v)}
            className={`whitespace-nowrap border-b-2 px-3.5 py-2 pb-3.5 text-[13px] transition-colors ${
              v === view
                ? "border-accent font-semibold text-foreground"
                : "border-transparent font-medium text-dim hover:text-foreground"
            }`}
          >
            {v}
          </button>
        ))}
      </nav>
      {/* key=scenario.id forces a full remount on scenario switch, so the
          drawer's local form state (settingsDraft, each PersonRow's draft)
          can't go stale relative to whichever scenario is now active. */}
      <AssumptionsDrawer key={scenario.id} open={assumptionsOpen} onClose={closeAssumptions} scenario={scenario} />
    </header>
  );
}
