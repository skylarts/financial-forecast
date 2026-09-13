/**
 * Schema version 5 → 6: retirement stops being an event and becomes a
 * property of the person.
 *
 * A `retire` event used to be the only thing the engine read -- the
 * retirement age on the person was inert, a number that merely seeded the
 * event's date. That meant a person with an age but no event (anyone added
 * from the Assumptions panel rather than through the setup wizard) kept
 * drawing a salary to the end of the plan, with nothing to say so.
 *
 * So each retire event is folded onto its person and then dropped:
 *
 *  - its date becomes `retirementDate` when it is NOT that person's birthday
 *    at their retirement age (a last day of work in June, a phased exit);
 *    when it matches, nothing is stored and the age keeps deriving it;
 *  - its `retirementAge` override, if it had one, becomes the person's age;
 *  - its `retirementExpense` becomes `retirementSpending`;
 *  - its notes become `retirementNotes`;
 *  - `isExcluded` becomes `skipRetirement`;
 *  - a person with SEVERAL retire events keeps the earliest, which is the one
 *    the engine already acted on.
 *
 * A person with no retire event at all is left exactly as they are: their age
 * now does the work the missing event never did, which is the fix.
 *
 * Runs on the raw JSON before the schema sees it, so a plan saved by any
 * earlier build still loads.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Add `months` calendar months, clamping the day -- a local copy so this file stays raw-JSON only. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

function birthdayAtAge(birthDate: string, age: number): string {
  return addMonths(birthDate, Math.round(age * 12));
}

/** True when the raw plan still carries a retire event. */
export function needsV5Migration(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return false;
  return raw.scenarios.some(
    (s: Json) => isRecord(s) && Array.isArray(s.events) && s.events.some((e: Json) => isRecord(e) && e.type === "retire")
  );
}

export function migrateV5Plan(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return raw;

  const scenarios = raw.scenarios.map((scenario: Json) => {
    if (!isRecord(scenario) || !Array.isArray(scenario.events)) return scenario;
    const retireEvents = scenario.events.filter((e: Json) => isRecord(e) && e.type === "retire");
    if (retireEvents.length === 0) return scenario;

    // Earliest wins, matching what the engine already did with duplicates.
    const byPerson = new Map<string, Json>();
    for (const e of retireEvents) {
      const existing = byPerson.get(e.personId);
      if (!existing || String(e.startDate) < String(existing.startDate)) byPerson.set(e.personId, e);
    }

    const people = (isRecord(scenario.household) && Array.isArray(scenario.household.people) ? scenario.household.people : []).map(
      (person: Json) => {
        const event = isRecord(person) ? byPerson.get(person.id) : undefined;
        if (!event) return person;

        const retirementAge = typeof event.retirementAge === "number" ? event.retirementAge : person.retirementAge;
        const next: Json = { ...person, retirementAge };

        // Keep the exact date only when the age cannot reproduce it, so the
        // common case stays a single number the user can edit in one place.
        const derived =
          typeof person.birthDate === "string" && typeof retirementAge === "number"
            ? birthdayAtAge(person.birthDate, retirementAge)
            : null;
        if (typeof event.startDate === "string" && event.startDate !== derived) next.retirementDate = event.startDate;

        if (event.isExcluded === true) next.skipRetirement = true;
        if (isRecord(event.retirementExpense)) next.retirementSpending = event.retirementExpense;
        if (typeof event.notes === "string" && event.notes.trim() !== "") next.retirementNotes = event.notes;
        return next;
      }
    );

    return {
      ...scenario,
      household: { ...(isRecord(scenario.household) ? scenario.household : {}), people },
      events: scenario.events.filter((e: Json) => !isRecord(e) || e.type !== "retire"),
    };
  });

  return { ...raw, scenarios };
}
