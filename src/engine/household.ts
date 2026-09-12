import type { FilingStatus, Id, ISODate, Person } from "@/domain";
import { birthdayAtAge, compareDates } from "./dateMath";

/**
 * What a person's planning-end age means to the engine: the date they are
 * modelled as passing. Everything that depends on who is alive reads it from
 * here so the rules stay in one place.
 */
export function deathDateOf(person: Pick<Person, "birthDate" | "planningEndAge">): ISODate {
  return birthdayAtAge(person.birthDate, person.planningEndAge);
}

/** True when the person is modelled as alive on `date` (the death date itself counts as alive). */
export function isAliveOn(person: Pick<Person, "birthDate" | "planningEndAge">, date: ISODate): boolean {
  return compareDates(date, deathDateOf(person)) <= 0;
}

/** The people alive on `date`, in household order. */
export function survivorsOn(people: Person[], date: ISODate): Person[] {
  return people.filter((p) => isAliveOn(p, date));
}

/**
 * The filing status the household uses for a tax year. A married household
 * whose two members have been reduced to one by the start of the year files
 * single from then on. (The two qualifying-widow(er) years are ignored.)
 */
export function filingStatusForYear(people: Person[], base: FilingStatus, year: number): FilingStatus {
  if (base !== "marriedFilingJointly") return base;
  if (people.length < 2) return base;
  const jan1: ISODate = `${year}-01-01`;
  const alive = survivorsOn(people, jan1).length;
  return alive <= 1 ? "single" : base;
}

/**
 * Who an account's age-based rules (the 59½ penalty, RMDs) look at on a
 * date: its owner while they live, then the surviving member the account
 * passes to. Null when nobody applicable is alive.
 */
export function effectiveOwnerOn(people: Person[], ownerId: Id | null, date: ISODate): Person | null {
  if (!ownerId) return null;
  const owner = people.find((p) => p.id === ownerId);
  if (!owner) return null;
  if (isAliveOn(owner, date)) return owner;
  const survivors = survivorsOn(people, date);
  return survivors[0] ?? null;
}
