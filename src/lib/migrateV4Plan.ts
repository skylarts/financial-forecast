/**
 * Schema version 4 → 5: real events for what a "custom transfer" used to
 * stand in for, and "have a kid" folded into ordinary expenses.
 *
 * Runs on the raw JSON before the schema sees it, so a plan saved by any
 * earlier build still loads. Nothing here needs re-entering afterwards:
 *
 *  - a `have_a_kid` event becomes a monthly childcare expense (plus a
 *    one-time expense for the upfront cost, when there was one);
 *  - a one-time `custom_transfer` from a tax-deferred account to a tax-free
 *    one becomes a `roth_conversion`; a recurring one becomes an annual
 *    conversion of the same yearly total;
 *  - a one-time `custom_transfer` between two tax-deferred accounts becomes a
 *    `rollover`;
 *  - a one-time `custom_transfer` into a loan or mortgage becomes a
 *    `pay_off_loan`.
 *
 * Recurring transfers that are not conversions stay custom transfers; the
 * engine already classifies them by their two accounts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function treatmentOf(account: Json | undefined): "taxable" | "tax_deferred" | "tax_free" | "n/a" {
  if (!isRecord(account)) return "n/a";
  if (account.taxTreatment && account.taxTreatment !== "n/a") return account.taxTreatment;
  switch (account.class) {
    case "taxable_investment":
      return "taxable";
    case "tax_deferred":
      return "tax_deferred";
    case "tax_free":
    case "hsa":
    case "education_529":
      return "tax_free";
    default:
      return "n/a";
  }
}

const PER_YEAR: Record<string, number> = { monthly: 12, biweekly: 26, weekly: 52, annual: 1, one_time: 1 };

/** True when the raw plan still carries anything this migration rewrites. */
export function needsV4Migration(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return false;
  return raw.scenarios.some(
    (s: Json) =>
      isRecord(s) &&
      Array.isArray(s.events) &&
      s.events.some((e: Json) => isRecord(e) && (e.type === "have_a_kid" || e.type === "custom_transfer"))
  );
}

export function migrateV4Plan(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return raw;
  return {
    ...raw,
    scenarios: raw.scenarios.map((s: Json) => (isRecord(s) ? migrateScenario(s) : s)),
  };
}

function migrateScenario(scenario: Record<string, Json>): Record<string, Json> {
  const accounts: Json[] = Array.isArray(scenario.accounts) ? scenario.accounts : [];
  const events: Json[] = Array.isArray(scenario.events) ? scenario.events : [];
  const expenses: Json[] = Array.isArray(scenario.expenses) ? [...scenario.expenses] : [];
  const hubId = accounts.find((a) => isRecord(a) && a.isExtraSavings)?.id;
  const byId = (id: unknown) => accounts.find((a) => isRecord(a) && a.id === id);

  const nextEvents: Json[] = [];
  for (const e of events) {
    if (!isRecord(e)) continue;
    if (e.type === "have_a_kid") {
      const payment = e.paymentAccountId === hubId ? null : (e.paymentAccountId ?? null);
      const monthly = Number(e.childcareMonthlyExpense) || 0;
      if (monthly > 0) {
        expenses.push({
          id: `${e.id}:childcare`,
          name: `Childcare: ${e.name}`,
          amount: monthly,
          frequency: "monthly",
          startDate: e.startDate,
          endDate: e.childcareEndDate ?? null,
          growthRatePct: null,
          paymentAccountId: payment,
          category: "childcare",
          isExcluded: e.isExcluded ?? undefined,
        });
      }
      const oneTime = Number(e.additionalOneTimeCost) || 0;
      if (oneTime > 0) {
        expenses.push({
          id: `${e.id}:onetime`,
          name: `One-time cost: ${e.name}`,
          amount: oneTime,
          frequency: "one_time",
          startDate: e.startDate,
          endDate: null,
          growthRatePct: null,
          paymentAccountId: payment,
          category: "childcare",
          isExcluded: e.isExcluded ?? undefined,
        });
      }
      continue;
    }
    if (e.type === "custom_transfer") {
      const from = byId(e.fromAccountId);
      const to = byId(e.toAccountId);
      const fromT = treatmentOf(from);
      const toT = treatmentOf(to);
      const oneTime = e.frequency === "one_time" && !e.intervalYears;
      const base = { id: e.id, name: e.name, startDate: e.startDate, notes: e.notes, isExcluded: e.isExcluded };
      if (isRecord(to) && to.category === "liability" && oneTime) {
        nextEvents.push({ ...base, type: "pay_off_loan", loanAccountId: e.toAccountId, fromAccountId: e.fromAccountId, amount: e.amount });
        continue;
      }
      if (fromT === "tax_deferred" && toT === "tax_free") {
        const perYear = e.intervalYears ? 1 : (PER_YEAR[e.frequency] ?? 1);
        nextEvents.push({
          ...base,
          endDate: e.endDate ?? null,
          type: "roth_conversion",
          fromAccountId: e.fromAccountId,
          toAccountId: e.toAccountId,
          amount: oneTime ? e.amount : Number(e.amount) * perYear,
          fillToBracketRate: null,
          frequency: oneTime ? "one_time" : "annual",
          taxSource: "cash",
          growthRatePct: e.growthRatePct ?? null,
        });
        continue;
      }
      if (fromT === "tax_deferred" && toT === "tax_deferred" && oneTime) {
        nextEvents.push({ ...base, type: "rollover", fromAccountId: e.fromAccountId, toAccountId: e.toAccountId, amount: e.amount });
        continue;
      }
    }
    nextEvents.push(e);
  }
  return { ...scenario, events: nextEvents, expenses };
}
