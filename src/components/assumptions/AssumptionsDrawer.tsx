"use client";

import { useState } from "react";
import type { Person, Scenario } from "@/domain";
import { personSchema, forecastSettingsSchema } from "@/domain";
import { addMonths } from "@/engine/dateMath";
import { Drawer } from "@/components/ui/Drawer";
import { ErrorBanner, InfoTooltip, PercentInput } from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";

/** The horizon year implied by the household's longest planning-end age. */
function horizonYearFromPeople(people: Person[]): number {
  return Math.max(...people.map((p) => Number(p.birthDate.slice(0, 4)) + p.planningEndAge));
}

function PersonRow({ person }: { person: Person }) {
  const updatePerson = usePlanStore((s) => s.updatePerson);
  const removePerson = usePlanStore((s) => s.removePerson);
  const [draft, setDraft] = useState(person);

  const save = () => {
    const result = personSchema.omit({ id: true }).safeParse(draft);
    if (!result.success) return;
    const retirementAgeChanged = result.data.retirementAge !== person.retirementAge;
    const planningEndChanged =
      result.data.planningEndAge !== person.planningEndAge || result.data.birthDate !== person.birthDate;
    updatePerson(person.id, result.data);

    // These two ages are only meaningful through what they derive -- keep the
    // derived things in sync so editing them here actually changes the plan:
    const { activeScenario, updateSettings, updateEvent } = usePlanStore.getState();
    const scenario = activeScenario();
    if (retirementAgeChanged) {
      // Move this person's Retire event(s) to their birthday at the new age.
      for (const e of scenario.events) {
        if (e.type !== "retire" || e.personId !== person.id) continue;
        const updated = {
          ...e,
          retirementAge: result.data.retirementAge,
          startDate: addMonths(result.data.birthDate, result.data.retirementAge * 12),
        };
        updateEvent(e.id, updated as Omit<typeof e, "id">);
      }
    }
    if (planningEndChanged) {
      // The horizon is derived from the longest planning-end age.
      const horizonYear = horizonYearFromPeople(scenario.household.people);
      updateSettings({ ...scenario.settings, horizonEndDate: `${horizonYear}-12-31` });
    }
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
        <span className="inline-flex items-center gap-1">
          Retirement age
          <InfoTooltip text="Changing this moves this person's Retire event (which is what actually stops their salary and contributions) to their birthday at the new age." />
        </span>
        <input
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          type="number"
          value={draft.retirementAge}
          onChange={(e) => setDraft({ ...draft, retirementAge: Number(e.target.value) })}
          onBlur={save}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-dim">
        <span className="inline-flex items-center gap-1">
          Planning end age
          <InfoTooltip text="Changing this extends or shortens the forecast horizon (the longest planning-end age in the household wins)." />
        </span>
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
  // Percent fields keep their raw typed string so decimals type naturally.
  const [inflationStr, setInflationStr] = useState(() => fractionToPercentStr(scenario.settings.inflationRatePct));
  const [flatTaxStr, setFlatTaxStr] = useState(() => fractionToPercentStr(scenario.settings.additionalFlatTaxRatePct));

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
            <span className="inline-flex items-center gap-1">
              Inflation rate (per year)
              <InfoTooltip text="Percent per year, e.g. 3 for 3%. Also the default growth rate for every input whose growth is left blank." />
            </span>
            <PercentInput
              value={inflationStr}
              placeholder="e.g. 3"
              onChange={(e) => {
                setInflationStr(e.target.value);
                const fraction = percentStrToFraction(e.target.value);
                if (fraction !== null) saveSettings({ ...settingsDraft, inflationRatePct: fraction });
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settingsDraft.rmdEnabled}
              onChange={(e) => saveSettings({ ...settingsDraft, rmdEnabled: e.target.checked })}
            />
            <span className="inline-flex items-center gap-1">
              Enable required minimum distributions (RMDs)
              <InfoTooltip text="Forced annual withdrawals from tax-deferred accounts flagged 'Subject to RMDs' -- starting at age 73, or 75 for anyone born 1960 or later (SECURE 2.0)." />
            </span>
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
                Additional flat tax rate
                <InfoTooltip text="State/local add-on to the computed federal tax, in percent (e.g. 5 for 5%). Leave at 0 if none -- correct as-is for a no-income-tax state." />
              </span>
              <PercentInput
                value={flatTaxStr}
                placeholder="e.g. 5"
                onChange={(e) => {
                  setFlatTaxStr(e.target.value);
                  const fraction = percentStrToFraction(e.target.value);
                  saveSettings({ ...settingsDraft, additionalFlatTaxRatePct: fraction ?? 0 });
                }}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-dim">
            <span className="inline-flex items-center gap-1">
              Horizon end date
              <InfoTooltip text="Normally derived from the household's longest planning-end age -- editing a person's planning end age updates this automatically. Set it directly only to override that." />
            </span>
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
