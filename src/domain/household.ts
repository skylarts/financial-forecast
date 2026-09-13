import { z } from "zod";
import { birthdayAtAge } from "@/engine/dateMath";
import { idSchema, isoDateSchema, type ISODate } from "./common";
import { temporaryAdjustmentSchema } from "./adjustment";

/**
 * The extra spending that starts the day someone retires -- more travel, more
 * hobbies, the things a full week suddenly has room for. Same shape as a
 * regular Expense (today's dollars, own growth rate, temporary windows), just
 * anchored to this person's retirement date instead of carrying its own.
 */
export const retirementSpendingSchema = z.object({
  /** Annual, today's dollars -- posted monthly so it doesn't land as a December lump. */
  amount: z.number().nonnegative(),
  /** Nominal annual growth, already including inflation. 0 = flat; null/omitted = match plan inflation. */
  growthRatePct: z.number().nullable().default(null),
  /** null = pays automatically from Extra Savings. */
  paymentAccountId: idSchema.nullable(),
  /** null/omitted = runs through the end of the plan. */
  endDate: isoDateSchema.nullable().optional(),
  /** Temporary scaling windows (e.g. a few extra years of travel budget). */
  adjustments: z.array(temporaryAdjustmentSchema).optional(),
});
export type RetirementSpending = z.infer<typeof retirementSpendingSchema>;

export const personSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  birthDate: isoDateSchema,
  /**
   * The age this person stops working. This is the plan's SINGLE source for
   * retirement: the engine reads it directly (through `retirementDateOf`) to
   * stop their salary, stop their payroll contributions, switch their
   * healthcare stage, and place the retirement KPIs and the chart's milestone.
   *
   * It used to be inert -- a separate `retire` EVENT carried the real date,
   * and this number only seeded it. That meant a person added here, with no
   * event created for them, kept drawing a salary to the end of the plan with
   * nothing to say so. The event type is gone; the four things it uniquely
   * carried live on this person now (the exact date below, the spending, the
   * skip toggle, and the notes).
   */
  retirementAge: z.number().int().positive(),
  /**
   * The exact retirement date, when it isn't simply the birthday at
   * `retirementAge` -- a last day of work in June, a phased exit. null/omitted
   * = derive it from the age, which is what almost every plan wants.
   */
  retirementDate: isoDateSchema.nullable().optional(),
  /** true = model this person working straight through, without deleting their retirement age. */
  skipRetirement: z.boolean().optional(),
  /** Extra spending from the day they retire; null/omitted = none. */
  retirementSpending: retirementSpendingSchema.nullable().optional(),
  /** Why this retirement is planned the way it is -- for you, and for anyone you share the plan with. */
  retirementNotes: z.string().optional(),
  /**
   * The age this person is modelled as living to. The plan runs through the
   * latest such date in the household, and the engine acts on it: their
   * salary and Social Security stop (the survivor keeps the larger benefit),
   * a pension continues at its survivor share, their accounts pass to the
   * survivor, and a married household files single from the following year.
   * Default 95 at creation time in the UI.
   */
  planningEndAge: z.number().int().positive(),
});
export type Person = z.infer<typeof personSchema>;

/**
 * The date this person retires, or null when they are modelled as never
 * retiring. THE one definition -- every consumer (the engine, the anchored
 * dates, the KPIs, the chart, the stress tests) goes through here, so there
 * is no second opinion about when someone stops working.
 */
export function retirementDateOf(person: Person): ISODate | null {
  if (person.skipRetirement) return null;
  return person.retirementDate ?? birthdayAtAge(person.birthDate, person.retirementAge);
}

/** The retiring people, earliest first -- the household's retirement timeline. */
export function retirementsInOrder(people: readonly Person[]): { person: Person; date: ISODate }[] {
  return people
    .flatMap((person) => {
      const date = retirementDateOf(person);
      return date ? [{ person, date }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const householdSchema = z.object({
  // No upper bound: the UI's "Add Person" flow has no cap, so the schema
  // must not either -- a hardcoded max(2) here previously meant a 3rd
  // person would fail validation on the next localStorage rehydration and
  // silently revert the whole plan to its last <=2-person state, discarding
  // real user data. At least one person is required for age-based
  // calculations (RMDs, retirement KPIs) to be meaningful.
  people: z.array(personSchema).min(1),
});
export type Household = z.infer<typeof householdSchema>;
