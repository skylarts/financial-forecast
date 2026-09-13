import { planSchema, scenarioSchema, type Plan, type Scenario, type ScenarioEvent } from "@/domain";
import { looksLikeV2Plan, migrateV2PlanToV3 } from "@/lib/migrateV2Plan";
import { migrateLegacyBuyHomeEvents } from "@/lib/migrateLegacyBuyHome";
import { migrateV4Plan, needsV4Migration } from "@/lib/migrateV4Plan";
import { migrateV5Plan, needsV5Migration } from "@/lib/migrateV5Plan";

/**
 * The one way a plan enters the app.
 *
 * Browser storage, the cloud row, and a restored backup file used to each run
 * a different subset of the migrations, so the same plan could load cleanly
 * from one path and be wiped by another. Everything now goes through
 * `normalizePlan`: every migration, the schema, and a referential repair pass,
 * in one order, with one result shape.
 *
 * It never throws and it never returns a plan with dangling references. What
 * it cannot repair it reports, so the caller can keep the raw bytes and say
 * what went wrong instead of quietly starting over.
 */

/** Bumped whenever the persisted shape changes in a way a migration handles. */
export const PLAN_SCHEMA_VERSION = 6;

export interface NormalizeOk {
  ok: true;
  plan: Plan;
  /** True when an older on-disk shape was migrated on the way in. */
  migrated: boolean;
  /** Human-readable notes on references that had to be repaired. Empty when the plan was already consistent. */
  repairs: string[];
}

export interface NormalizeFail {
  ok: false;
  /** One sentence a person can act on. */
  error: string;
  /** The field the schema objected to, dotted, when there is one. */
  path?: string;
}

export type NormalizeResult = NormalizeOk | NormalizeFail;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accepts either a plain plan (what Backup writes) or the raw zustand-persist
 * envelope `{ state: { plan }, version }` (what recover.html downloads).
 */
export function unwrapPlanEnvelope(raw: unknown): unknown {
  if (isRecord(raw) && isRecord(raw.state) && "plan" in raw.state) return raw.state.plan;
  return raw;
}

/**
 * Drops routing stops and optional references that point at nothing, and
 * removes events whose required references point at nothing. Returns the
 * repaired scenario and a note per repair.
 */
export function repairReferences(scenario: Scenario): { scenario: Scenario; repairs: string[] } {
  const repairs: string[] = [];
  const accountIds = new Set(scenario.accounts.map((a) => a.id));
  const personIds = new Set(scenario.household.people.map((p) => p.id));
  const hasAccount = (id: string | null | undefined) => id == null || accountIds.has(id);
  const hasPerson = (id: string | null | undefined) => id == null || personIds.has(id);

  // Retirement spending names an account to pay from, and that account can be
  // deleted out from under it -- the same repair every other account link gets.
  const people = scenario.household.people.map((person) => {
    const spending = person.retirementSpending;
    if (!spending || hasAccount(spending.paymentAccountId)) return person;
    repairs.push(`${person.name}: the account their retirement spending was paid from no longer exists, so it now comes from Extra Savings.`);
    return { ...person, retirementSpending: { ...spending, paymentAccountId: null } };
  });

  const accounts = scenario.accounts.map((a) => {
    let next = a;
    if (!hasPerson(a.ownerId)) {
      repairs.push(`${a.name}: its owner no longer exists, so it is now joint.`);
      next = { ...next, ownerId: null };
    }
    if (next.linkedLiabilityId && !accountIds.has(next.linkedLiabilityId)) {
      repairs.push(`${a.name}: its mortgage no longer exists, so the link was cleared.`);
      const { linkedLiabilityId: _dropped, ...rest } = next;
      void _dropped;
      next = rest;
    }
    if (next.loanTerms?.linkedAssetId && !accountIds.has(next.loanTerms.linkedAssetId)) {
      repairs.push(`${a.name}: the home it was linked to no longer exists, so the link was cleared.`);
      const { linkedAssetId: _dropped, ...loanTerms } = next.loanTerms;
      void _dropped;
      next = { ...next, loanTerms };
    }
    return next;
  });

  const incomeSources = scenario.incomeSources.map((i) => {
    let next = i;
    if (!hasPerson(i.ownerId)) {
      repairs.push(`${i.name}: its owner no longer exists, so it is now joint.`);
      next = { ...next, ownerId: null };
    }
    if (!hasAccount(i.depositAccountId)) {
      repairs.push(`${i.name}: its deposit account no longer exists, so it now lands in Extra Savings.`);
      next = { ...next, depositAccountId: null };
    }
    return next;
  });

  const expenses = scenario.expenses.map((e) => {
    if (!hasAccount(e.paymentAccountId)) {
      repairs.push(`${e.name}: its payment account no longer exists, so it is now paid from Extra Savings.`);
      return { ...e, paymentAccountId: null };
    }
    return e;
  });

  const events: ScenarioEvent[] = scenario.events.flatMap((e): ScenarioEvent[] => {
    switch (e.type) {
      case "buy_home":
        if (!accountIds.has(e.realEstateAccountId) || !accountIds.has(e.downPaymentFromAccountId)) {
          repairs.push(`${e.name}: an account it needs no longer exists, so the event was removed.`);
          return [];
        }
        return [e];
      case "sell_home":
        if (!accountIds.has(e.realEstateAccountId)) {
          repairs.push(`${e.name}: the home it sells no longer exists, so the event was removed.`);
          return [];
        }
        if (!hasAccount(e.proceedsAccountId)) {
          repairs.push(`${e.name}: its proceeds account no longer exists, so proceeds now land in Extra Savings.`);
          return [{ ...e, proceedsAccountId: null }];
        }
        return [e];
      case "roth_conversion":
      case "rollover":
      case "custom_transfer":
        if (!accountIds.has(e.fromAccountId) || !accountIds.has(e.toAccountId)) {
          repairs.push(`${e.name}: an account it moves money between no longer exists, so the event was removed.`);
          return [];
        }
        return [e];
      case "pay_off_loan":
        if (!accountIds.has(e.fromAccountId) || !accountIds.has(e.loanAccountId)) {
          repairs.push(`${e.name}: the loan or the paying account no longer exists, so the event was removed.`);
          return [];
        }
        return [e];
      default:
        return [e];
    }
  });

  const { splitOrder, drainOrder } = scenario.settings.moneyFlow;
  const keptSplit = splitOrder.filter((s) => accountIds.has(s.accountId));
  const keptDrain = drainOrder.filter((s) => accountIds.has(s.accountId));
  if (keptSplit.length !== splitOrder.length) repairs.push("A surplus-split stop pointed at a missing account and was dropped.");
  if (keptDrain.length !== drainOrder.length) repairs.push("A drain-order stop pointed at a missing account and was dropped.");

  if (repairs.length === 0) return { scenario, repairs };
  return {
    scenario: {
      ...scenario,
      household: { people },
      accounts,
      incomeSources,
      expenses,
      events,
      settings: { ...scenario.settings, moneyFlow: { splitOrder: keptSplit, drainOrder: keptDrain } },
    },
    repairs,
  };
}

/** Whether a scenario holds anything a person typed: an account, income, expense, or event. */
export function scenarioHasContent(scenario: Scenario): boolean {
  return (
    scenario.accounts.some((a) => !a.isExtraSavings) ||
    scenario.incomeSources.length > 0 ||
    scenario.expenses.length > 0 ||
    scenario.events.length > 0
  );
}

/** Whether any scenario in the plan holds content. The empty first-run plan does not. */
export function planHasContent(plan: Plan): boolean {
  return plan.scenarios.some(scenarioHasContent);
}

/**
 * Migrate, validate, and repair a raw plan. The only entry point for plans
 * arriving from storage, the cloud, or a file.
 */
export function normalizePlan(raw: unknown): NormalizeResult {
  const unwrapped = unwrapPlanEnvelope(raw);
  if (!isRecord(unwrapped)) {
    return { ok: false, error: "That is not a Forecast plan: expected a JSON object with scenarios." };
  }
  const wasV2 = looksLikeV2Plan(unwrapped);
  const v3 = wasV2 ? migrateV2PlanToV3(unwrapped) : unwrapped;
  const withHomes = migrateLegacyBuyHomeEvents(v3);
  const wasV4 = needsV4Migration(withHomes);
  const v5 = wasV4 ? migrateV4Plan(withHomes) : withHomes;
  const wasV5 = needsV5Migration(v5);
  const candidate = wasV5 ? migrateV5Plan(v5) : v5;
  const migrated = wasV2 || wasV4 || wasV5;
  const result = planSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? issue.path.map(String).join(".") : undefined;
    return {
      ok: false,
      error: issue ? `${issue.message}${path ? ` (at ${path})` : ""}` : "That file isn't a valid Forecast plan.",
      path,
    };
  }

  const repairs: string[] = [];
  const scenarios = result.data.scenarios.map((s) => {
    const repaired = repairReferences(s);
    repairs.push(...repaired.repairs.map((r) => `${s.name}: ${r}`));
    return repaired.scenario;
  });
  let activeScenarioId = result.data.activeScenarioId;
  if (!scenarios.some((s) => s.id === activeScenarioId)) {
    activeScenarioId = scenarios[0].id;
    repairs.push("The active scenario no longer existed, so the first one is active.");
  }
  const plan: Plan = { ...result.data, scenarios, activeScenarioId, schemaVersion: PLAN_SCHEMA_VERSION };
  const wasOldVersion = (unwrapped.schemaVersion as number | undefined) !== PLAN_SCHEMA_VERSION;
  return { ok: true, plan, migrated: migrated || wasOldVersion, repairs };
}

/** Parses a scenario built in code (a fixture, a sample) through the schema so it is in current shape. */
export function normalizeScenario(raw: unknown): Scenario {
  return scenarioSchema.parse(raw);
}
