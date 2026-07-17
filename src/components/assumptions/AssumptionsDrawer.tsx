"use client";

import { useState } from "react";
import type { Person, Scenario } from "@/domain";
import { personSchema, forecastSettingsSchema } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { ErrorBanner, InfoTooltip } from "@/components/ui/formFields";
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
            <span className="inline-flex items-center gap-1">
              Start date
              <InfoTooltip text="Every account's balance is treated as being as of this date, and growth/contributions compound forward from here (accounts created by an event, like a home purchase, use that event's date instead). Moving this date without also updating each account's Starting Balance will make the projection skip or double-count time." />
            </span>
            <input
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              type="date"
              value={settingsDraft.startDate}
              onChange={(e) => saveSettings({ ...settingsDraft, startDate: e.target.value })}
            />
          </label>
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
            <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
              Federal tax
              <InfoTooltip text="Computed automatically each year from real IRS brackets, based on that year's actual realized income (RMDs, taxable Social Security, pension, capital gains). See the computed amount on the Cash Flow tab." />
            </div>
            <label className="mb-2 flex flex-col gap-1 text-xs text-dim">
              Filing status
              <select
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                value={settingsDraft.filingStatus}
                onChange={(e) =>
                  saveSettings({ ...settingsDraft, filingStatus: e.target.value as typeof settingsDraft.filingStatus })
                }
              >
                <option value="marriedFilingJointly">Married filing jointly</option>
                <option value="single">Single</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-dim">
              <span className="inline-flex items-center gap-1">
                Additional flat tax rate (e.g. 0.05 for 5%)
                <InfoTooltip text="State/local add-on to the computed federal tax. Leave at 0 if none." />
              </span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                type="number"
                step="0.01"
                value={settingsDraft.additionalFlatTaxRatePct}
                onChange={(e) =>
                  saveSettings({ ...settingsDraft, additionalFlatTaxRatePct: Number(e.target.value) })
                }
              />
            </label>
          </div>
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
