import { z } from "zod";

/** UUID/nanoid identifier for every entity. */
export const idSchema = z.string().min(1);
export type Id = z.infer<typeof idSchema>;

/** 'YYYY-MM-DD' */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export type ISODate = z.infer<typeof isoDateSchema>;

export const recurrenceFrequencySchema = z.enum([
  "monthly",
  "biweekly",
  "weekly",
  "annual",
  "one_time",
]);
export type RecurrenceFrequency = z.infer<typeof recurrenceFrequencySchema>;
