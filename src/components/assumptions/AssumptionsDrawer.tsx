"use client";

import { useState } from "react";
import type { Person, Scenario } from "@/domain";
import { personSchema, forecastSettingsSchema, DEFAULT_WITHDRAWAL_TAX_RATES } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { ErrorBanner } from "@/components/ui/formFields";
import { usePlanStore } from "@/store/usePlanStore";

function PersonRow({ person }: { person: Person }) {
  const updatePerson = usePlanStore((s) => s.updatePerson);
  const removePerson = usePlanStore((s) => s.removePerson);
  const [draft, setDraft] = useState(person);

  const save = () => {
    const result = personSchema.omit({ id: true }).safeParse(draft);
    if (result.success) updatePerson(person.id, result.data);
  };

  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
      <input
        className="col-span-2 rounded border border-border bg-background px-2 py-1 text-sm"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        onBlur={save}
        placeholder="Name"
      />
      <input
        className="rounded border border-border bg-background px-2 py-1 text-sm"
        type="date"
        value={draft.birthDate}
        onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
        onBlur={save}
      />
      <div />
      <label className="flex flex-col gap-1 text-xs text-dim">
        Retirement age
        <input
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          type="number"
          value={draft.retirementAge}
          onChange={(e) => setDraft({ ...draft, retirementAge: Number(e.target.value) })}
          onBlur={save}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-dim">
        Planning end age
        <input
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          type="number"
          value={draft.planningEndAge}
          onChange={(e) => setDraft({ ...draft, planningEndAge: Number(e.target.value) })}
          onBlur={save}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          const removed = removePerson(person.id);
          if (!removed) {
            alert(
              `Can't remove ${person.name || "this person"} -- they're still the owner of an account or income source, or referenced by an event (e.g. Retire, Social Security). Update or delete those first.`
            );
          }
        }}
        className="col-span-2 rounded-md border border-negative/40 py-1 text-xs text-negative hover:bg-negative/10"
      >
        Remove {person.name || "person"}
      </button>
    </div>
  );
}

export function AssumptionsDrawer({ open, onClose, scenario }: { open: boolean; onClose: () => void; scenario: Scenario }) {
  const addPerson = usePlanStore((s) => s.addPerson);
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const [newPersonName, setNewPersonName] = useState("");

  const [settingsDraft, setSettingsDraft] = useState(scenario.settings);
  const taxRates = settingsDraft.withdrawalTaxRates ?? DEFAULT_WITHDRAWAL_TAX_RATES;

  const saveSettings = (next: typeof settingsDraft) => {
    setSettingsDraft(next);
    const result = forecastSettingsSchema.safeParse(next);
    if (result.success) {
      setError(null);
      updateSettings(result.data);
    } else {
      setError(result.error.issues[0]?.message ?? "Invalid settings.");
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Assumptions">
      <div className="flex flex-col gap-5">
        <ErrorBanner message={error} />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">Household</h3>
          {scenario.household.people.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="New person's name"
              value={newPersonName}
              onChange={(e) => setNewPersonName(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                if (!newPersonName.trim()) return;
                addPerson({ name: newPersonName.trim(), birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 });
                setNewPersonName("");
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
            >
              Add
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">Global Assumptions</h3>
          <label className="flex flex-col gap-1 text-xs text-dim">
            Inflation rate (e.g. 0.03 for 3%)
            <input
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              type="number"
              step="0.001"
              value={settingsDraft.inflationRatePct}
              onChange={(e) => saveSettings({ ...settingsDraft, inflationRatePct: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settingsDraft.rmdEnabled}
              onChange={(e) => saveSettings({ ...settingsDraft, rmdEnabled: e.target.checked })}
            />
            Enable RMDs at age 73+
          </label>

          <div className="rounded-md border border-border p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-dim">Withdrawal tax rates</div>
            <p className="mb-2 text-xs text-dim">
              Applied when money is drawn from accounts (RMDs and covering shortfalls). Income is entered as take-home,
              so these bite only on retirement-account withdrawals. Enter as decimals (e.g. 0.22 for 22%).
            </p>
            {(
              [
                ["taxDeferredPct", "Tax-deferred (401k / traditional IRA)"],
                ["taxablePct", "Taxable brokerage (capital gains)"],
                ["taxFreePct", "Tax-free (Roth)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="mb-2 flex flex-col gap-1 text-xs text-dim last:mb-0">
                {label}
                <input
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                  type="number"
                  step="0.01"
                  value={taxRates[key]}
                  onChange={(e) =>
                    saveSettings({
                      ...settingsDraft,
                      withdrawalTaxRates: { ...taxRates, [key]: Number(e.target.value) },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-dim">
            Spending accounts, surplus routing, and drain order live in the{" "}
            <span className="font-medium text-foreground">Money Flow</span> tab now, not here.
          </p>
          <label className="flex flex-col gap-1 text-xs text-dim">
            Horizon end date
            <input
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              type="date"
              value={settingsDraft.horizonEndDate}
              onChange={(e) => saveSettings({ ...settingsDraft, horizonEndDate: e.target.value })}
            />
          </label>
        </section>

        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
          Close
        </button>
      </div>
    </Drawer>
  );
}
