/**
 * Best-effort structural migration from the pre-streamlining (v2) plan shape
 * to the current one, so an existing real v2 backup file can be restored
 * into v3 without silently dropping data.
 *
 * v2 stored cash-flow routing on each account (isSpendingAccount,
 * targetCashBalance, withdrawalPriority, isSurplusTarget,
 * surplusTargetPriority, maxBalance, maxBalanceGrowthRatePct) plus a global
 * settings.surplusRoutingRule; v3 moves all of that into
 * settings.moneyFlow -- without this migration, importing a v2 file would
 * either fail validation (missing required fields) or, worse, silently
 * succeed with an EMPTY moneyFlow (since it's a defaulted field), discarding
 * every spending-account/surplus-target/withdrawal-priority setting with no
 * visible error. v2 also had three event types (income_change,
 * expense_change, windfall) that v3 folds directly onto income/expense
 * entities.
 *
 * This operates on loosely-typed JSON (not the old Zod schemas, which no
 * longer exist in this codebase) -- whatever it produces is re-validated by
 * planSchema immediately after by the caller, so a malformed migration fails
 * loudly (a clear Zod error) rather than silently corrupting data.
 *
 * v2 also had a social_security_start event; v3 has no such event because
 * the special once-per-year COLA math it existed for is actually keyed off
 * IncomeSource.category === "social_security", not the event -- so the
 * event just synthesized a plain Income entry. This migration does the same
 * synthesis once, up front, instead of at every forecast run.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if `raw` has any structural marker of the old (v2) plan shape. */
export function looksLikeV2Plan(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return false;
  return raw.scenarios.some((s: Json) => {
    if (!isRecord(s)) return false;
    const accountHasLegacyField = Array.isArray(s.accounts) && s.accounts.some((a: Json) => isRecord(a) && "isSpendingAccount" in a);
    const settingsHasLegacyField = isRecord(s.settings) && ("surplusRoutingRule" in s.settings || "defaultGrowthByClass" in s.settings);
    const hasLegacyEvent =
      Array.isArray(s.events) &&
      s.events.some(
        (e: Json) =>
          isRecord(e) && ["income_change", "expense_change", "windfall", "social_security_start"].includes(e.type)
      );
    return accountHasLegacyField || settingsHasLegacyField || hasLegacyEvent;
  });
}

function migrateMoneyFlow(accounts: Json[], surplusRoutingRule: Json | undefined) {
  const hubs = accounts
    .filter((a) => a.isSpendingAccount === true)
    .map((a) => ({ accountId: a.id, bufferAmount: a.targetCashBalance ?? null }));
  const fillOrder = accounts
    .filter((a) => a.isSurplusTarget === true)
    .sort((a, b) => (a.surplusTargetPriority ?? 0) - (b.surplusTargetPriority ?? 0))
    .map((a) => ({
      accountId: a.id,
      maxBalance: a.maxBalance ?? null,
      maxBalanceGrowthRatePct: a.maxBalanceGrowthRatePct ?? null,
      splitPct:
        surplusRoutingRule?.mode === "fixed_split"
          ? (surplusRoutingRule.splits ?? []).find((s: Json) => s.accountId === a.id)?.pct ?? null
          : null,
    }));
  const drainOrder = accounts
    .filter((a) => a.withdrawalPriority != null)
    .sort((a, b) => a.withdrawalPriority - b.withdrawalPriority)
    .map((a) => ({ accountId: a.id, startDate: null, endDate: null, splitPct: null }));
  return {
    hubs,
    fillOrder,
    drainOrder,
    fillSplitMode: surplusRoutingRule?.mode ?? "priority_fill",
    drainSplitMode: "priority_fill",
  };
}

const LEGACY_ACCOUNT_FIELDS = [
  "isSpendingAccount",
  "targetCashBalance",
  "withdrawalPriority",
  "isSurplusTarget",
  "surplusTargetPriority",
  "maxBalance",
  "maxBalanceGrowthRatePct",
  "linkedExternally",
  "balanceUpdateRequired",
];

function stripLegacyAccountFields(account: Json): Json {
  const clean = { ...account };
  for (const field of LEGACY_ACCOUNT_FIELDS) delete clean[field];
  return clean;
}

function migrateScenario(scenario: Json): Json {
  // moneyFlow is derived from the raw (unstripped) accounts first, then the
  // legacy per-account fields are dropped from the accounts themselves.
  const rawAccounts: Json[] = scenario.accounts ?? [];
  const moneyFlow = migrateMoneyFlow(rawAccounts, scenario.settings?.surplusRoutingRule);
  const accounts = rawAccounts.map(stripLegacyAccountFields);
  const incomeSources: Json[] = [...(scenario.incomeSources ?? [])];
  const expenses: Json[] = [...(scenario.expenses ?? [])];
  const remainingEvents: Json[] = [];

  for (const event of scenario.events ?? []) {
    if (event.type === "income_change") {
      const target = incomeSources.find((i) => i.id === event.targetIncomeSourceId);
      if (target) {
        target.adjustments = [
          ...(target.adjustments ?? []),
          { id: event.id, startDate: event.startDate, endDate: event.endDate ?? null, multiplier: event.multiplier ?? 0 },
        ];
      }
      continue; // event is fully absorbed into the income source
    }
    if (event.type === "expense_change") {
      const target = expenses.find((e) => e.id === event.targetExpenseId);
      if (target) {
        target.adjustments = [
          ...(target.adjustments ?? []),
          { id: event.id, startDate: event.startDate, endDate: event.endDate ?? null, multiplier: event.multiplier ?? 0 },
        ];
      }
      continue;
    }
    if (event.type === "windfall") {
      const isRecurring = event.isRecurring === true;
      const frequency = isRecurring ? event.frequency ?? "annual" : "one_time";
      const shared = {
        id: event.id,
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate ?? null,
        frequency,
        intervalYears: isRecurring ? event.intervalYears : undefined,
        growthRatePct: 0,
        isExcluded: event.isExcluded,
        adjustments: [],
      };
      if (event.amount >= 0) {
        incomeSources.push({ ...shared, ownerId: null, amount: event.amount, depositAccountId: event.depositAccountId, category: "other" });
      } else {
        expenses.push({ ...shared, amount: Math.abs(event.amount), paymentAccountId: event.depositAccountId, category: "other" });
      }
      continue;
    }
    if (event.type === "social_security_start") {
      incomeSources.push({
        id: event.id,
        name: event.name,
        ownerId: event.personId,
        amount: event.monthlyBenefitAmount,
        frequency: "monthly",
        startDate: event.startDate,
        endDate: null,
        // Same default the old event used: an unset COLA tracked the plan's
        // inflation assumption at the time.
        growthRatePct: event.growthRatePct ?? scenario.settings?.inflationRatePct ?? 0,
        depositAccountId: event.depositAccountId,
        category: "social_security",
        isExcluded: event.isExcluded,
        adjustments: [],
      });
      continue;
    }
    remainingEvents.push(event);
  }

  const { defaultGrowthByClass: _dead1, surplusRoutingRule: _dead2, ...cleanSettings } = scenario.settings ?? {};
  void _dead1;
  void _dead2;

  return {
    ...scenario,
    accounts,
    incomeSources,
    expenses,
    events: remainingEvents,
    settings: { ...cleanSettings, moneyFlow },
  };
}

export function migrateV2PlanToV3(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return raw;
  return { ...raw, scenarios: raw.scenarios.map(migrateScenario) };
}
