import { z } from "zod";
import { addDays, addMonths, birthdayAtAge, compareDates } from "@/engine/dateMath";
import { idSchema, type ISODate } from "./common";
import type { Person } from "./household";

/**
 * A date that is DERIVED from a life milestone instead of typed in.
 *
 * Half the dates in a real plan are not facts, they are consequences: a
 * pension starts when you retire, a salary stops when you retire, the
 * healthcare bridge runs from retirement until Medicare, the Roth-conversion
 * window opens the year the paychecks stop. Before this existed, every one of
 * those was a separate hard-coded `YYYY-MM-DD`, so asking "what if I retire at
 * 54 instead of 52?" meant hand-editing a dozen unrelated fields and hoping
 * none were missed -- the kind of edit that silently leaves a pension starting
 * two years before the income it replaces.
 *
 * An anchored date stores the RULE ("Skylar's retirement, plus 24 months") and
 * the app recomputes the concrete date every time the plan changes. Nothing
 * downstream has to know: `resolveAnchoredDates` writes the answer back into
 * the ordinary `startDate` / `endDate` fields, so the engine, the CSV export,
 * the tables and the charts keep reading plain dates exactly as before.
 */
export const dateAnchorSchema = z.object({
  /** Whose milestone this follows. */
  personId: idSchema,
  /** Only retirement for now; an enum so a later milestone (Medicare, death) slots in without a migration. */
  point: z.literal("retirement").default("retirement"),
  /** Signed months from that milestone: -24 = two years before, 0 = the day itself. */
  offsetMonths: z.number().int().default(0),
});
export type DateAnchor = z.infer<typeof dateAnchorSchema>;

/** An anchored date field on an income source, expense or event. */
export const dateAnchorFields = {
  /** When set, `startDate` is computed from this and the typed value is ignored. */
  startAnchor: dateAnchorSchema.nullable().optional(),
  /** When set, `endDate` is computed from this -- the DAY BEFORE the anchor point (see `resolveEndAnchor`). */
  endAnchor: dateAnchorSchema.nullable().optional(),
};

/** Anything the resolver can rewrite: it only ever touches these two fields. */
type Anchorable = {
  startDate: ISODate;
  endDate?: ISODate | null;
  startAnchor?: DateAnchor | null;
  endAnchor?: DateAnchor | null;
};

/**
 * The date a person's retirement lands on.
 *
 * A `retire` event wins when there is one, because that event may carry its
 * own `retirementAge` override and is what the engine itself keys off (it is
 * what stops a salary and its payroll contributions). The earliest such event
 * wins, matching the engine's own rule in resolveEvents.ts. With no event, the
 * person's profile age is the answer, so an anchor still resolves in a plan
 * that has not got as far as adding the event.
 */
export function retirementDateFor(
  people: readonly Person[],
  events: readonly { type: string; personId?: string; startDate: ISODate; isExcluded?: boolean }[],
  personId: string
): ISODate | null {
  let fromEvent: ISODate | null = null;
  for (const event of events) {
    if (event.type !== "retire" || event.personId !== personId || event.isExcluded) continue;
    if (!fromEvent || compareDates(event.startDate, fromEvent) < 0) fromEvent = event.startDate;
  }
  if (fromEvent) return fromEvent;
  const person = people.find((p) => p.id === personId);
  return person ? birthdayAtAge(person.birthDate, person.retirementAge) : null;
}

/** The concrete date an anchor points at, or null when the person it names is gone. */
export function resolveAnchor(
  anchor: DateAnchor,
  people: readonly Person[],
  events: readonly { type: string; personId?: string; startDate: ISODate; isExcluded?: boolean }[]
): ISODate | null {
  const base = retirementDateFor(people, events, anchor.personId);
  return base ? addMonths(base, anchor.offsetMonths) : null;
}

/**
 * An END anchor resolves to the day BEFORE the anchor point, because `endDate`
 * is inclusive: "my salary ends when I retire" means the last paycheck is
 * before retirement day, not on it. This is the same day-before trim the
 * engine already applies to a salary at its owner's retire event, so an
 * explicit end anchor and the automatic rule agree instead of fighting.
 */
export function resolveEndAnchor(
  anchor: DateAnchor,
  people: readonly Person[],
  events: readonly { type: string; personId?: string; startDate: ISODate; isExcluded?: boolean }[]
): ISODate | null {
  const at = resolveAnchor(anchor, people, events);
  return at ? addDays(at, -1) : null;
}

function applyAnchors<T extends Anchorable>(
  item: T,
  people: readonly Person[],
  events: readonly { type: string; personId?: string; startDate: ISODate; isExcluded?: boolean }[]
): T {
  let next = item;
  if (item.startAnchor) {
    const resolved = resolveAnchor(item.startAnchor, people, events);
    // An unresolvable anchor (the person was removed) leaves the last computed
    // date standing rather than blanking a required field.
    if (resolved && resolved !== item.startDate) next = { ...next, startDate: resolved };
  }
  if (item.endAnchor && "endDate" in item) {
    const resolved = resolveEndAnchor(item.endAnchor, people, events);
    if (resolved && resolved !== item.endDate) next = { ...next, endDate: resolved };
  }
  return next;
}

/**
 * Rewrite every anchored `startDate` / `endDate` in a scenario from its rule.
 *
 * Called at both chokepoints -- every store mutation and every schema parse --
 * so the stored dates are never stale, whichever field the user actually
 * changed. Returns the same object when nothing moved, so it is free to run on
 * every keystroke-sized edit.
 *
 * A `retire` event is deliberately skipped: it IS the anchor point, so letting
 * one anchor itself would be circular.
 */
export function resolveAnchoredDates<
  T extends {
    household: { people: Person[] };
    incomeSources: Anchorable[];
    expenses: Anchorable[];
    events: (Anchorable & { type: string; personId?: string; isExcluded?: boolean })[];
  },
>(scenario: T): T {
  const people = scenario.household.people;
  const events = scenario.events;

  let changed = false;
  const mapped = <I extends Anchorable>(items: I[]): I[] =>
    items.map((item) => {
      const next = applyAnchors(item, people, events);
      if (next !== item) changed = true;
      return next;
    });

  const incomeSources = mapped(scenario.incomeSources);
  const expenses = mapped(scenario.expenses);
  const nextEvents = scenario.events.map((event) => {
    if (event.type === "retire") return event;
    const next = applyAnchors(event, people, events);
    if (next !== event) changed = true;
    return next;
  });

  if (!changed) return scenario;
  return { ...scenario, incomeSources, expenses, events: nextEvents };
}

/** How many dated fields in a scenario follow this person's retirement -- the "if I move this, N things move" count. */
export function countAnchorsToPerson(
  scenario: {
    incomeSources: Anchorable[];
    expenses: Anchorable[];
    events: (Anchorable & { type: string })[];
  },
  personId: string
): number {
  const items: Anchorable[] = [
    ...scenario.incomeSources,
    ...scenario.expenses,
    ...scenario.events.filter((e) => e.type !== "retire"),
  ];
  let count = 0;
  for (const item of items) {
    if (item.startAnchor?.personId === personId) count += 1;
    if (item.endAnchor?.personId === personId) count += 1;
  }
  return count;
}

/** The offsets the pickers offer: common round distances either side of the milestone. */
export const ANCHOR_OFFSET_OPTIONS: { value: number; label: string }[] = [
  { value: -120, label: "10 years before" },
  { value: -60, label: "5 years before" },
  { value: -36, label: "3 years before" },
  { value: -24, label: "2 years before" },
  { value: -12, label: "1 year before" },
  { value: -6, label: "6 months before" },
  { value: 0, label: "At retirement" },
  { value: 6, label: "6 months after" },
  { value: 12, label: "1 year after" },
  { value: 24, label: "2 years after" },
  { value: 36, label: "3 years after" },
  { value: 48, label: "4 years after" },
  { value: 60, label: "5 years after" },
  { value: 120, label: "10 years after" },
  { value: 180, label: "15 years after" },
  { value: 240, label: "20 years after" },
];

/** An offset in plain words: "2 years before", "8 months after", "at". */
export function offsetLabel(offsetMonths: number): string {
  const known = ANCHOR_OFFSET_OPTIONS.find((o) => o.value === offsetMonths);
  if (known) return offsetMonths === 0 ? "at" : known.label.toLowerCase();
  const months = Math.abs(offsetMonths);
  const side = offsetMonths < 0 ? "before" : "after";
  if (months % 12 === 0) return `${months / 12} year${months === 12 ? "" : "s"} ${side}`;
  return `${months} month${months === 1 ? "" : "s"} ${side}`;
}

/** A whole anchor in plain words: "2 years after Skylar's retirement". */
export function anchorLabel(anchor: DateAnchor, people: readonly Person[]): string {
  const name = people.find((p) => p.id === anchor.personId)?.name ?? "someone";
  const possessive = name.endsWith("s") ? `${name}'` : `${name}'s`;
  const offset = offsetLabel(anchor.offsetMonths);
  return offset === "at" ? `${possessive} retirement` : `${offset} ${possessive} retirement`;
}
