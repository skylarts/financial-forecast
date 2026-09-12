import { z } from "zod";
import { idSchema, isoDateSchema } from "./common";

export const personSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  birthDate: isoDateSchema,
  retirementAge: z.number().int().positive(),
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
