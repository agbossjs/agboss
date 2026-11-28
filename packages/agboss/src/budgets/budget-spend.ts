import { LimitError } from "../core/error-families/limit-errors.js";
import { resolveReferences } from "../environments/define-env.js";
import { totalCost, totalTokens, type UsageRecord } from "../finops/usage.js";
import { isFiniteNumber, shownLimit } from "../graph/count-limit.js";
import type { BudgetLimit, BudgetUsage } from "../infrastructure/cost-ledger.repository.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import { usd, type Usd } from "../units/index.js";
import { BudgetUnit, type BudgetHandler, type BudgetMeta } from "./budget.js";
import {
  counterKeyOf,
  type CostLedgerRepository,
} from "../infrastructure/cost-ledger.repository.js";
import { counterOf, type ExecutionBudgetRecord } from "./budget-check.js";

/**
 * What a budget counts (#1318): the dollars and the tokens spent, added and compared together. A
 * `$0` call with tokens (an unpriced CLI or local model) is spend of tokens only — never dropped
 * because its cost is 0.
 */
export interface Spend {
  readonly usd: number;
  readonly tokens: number;
}

/** No spend. */
export const NO_SPEND: Spend = { usd: 0, tokens: 0 };

/** The spend of `records`: their costs and their input plus output tokens. */
export const spendOf = (records: readonly UsageRecord[]): Spend => ({
  usd: totalCost(records),
  tokens: totalTokens(records),
});

/** What a counter holds, as spend. */
export const spendOfUsage = (usage: BudgetUsage): Spend => ({
  usd: usage.spent,
  tokens: usage.tokens,
});

/** `a` and `b` together. */
export const plus = (a: Spend, b: Spend): Spend => ({
  usd: a.usd + b.usd,
  tokens: a.tokens + b.tokens,
});

/** `a` less `b`, each part on its own. */
export const minus = (a: Spend, b: Spend): Spend => ({
  usd: a.usd - b.usd,
  tokens: a.tokens - b.tokens,
});

/** The larger of `a` and `b`, each part on its own. */
export const larger = (a: Spend, b: Spend): Spend => ({
  usd: Math.max(a.usd, b.usd),
  tokens: Math.max(a.tokens, b.tokens),
});

/**
 * The least any record has left of its cap — `Infinity` when none has that cap (#1318): dollars of
 * `maxSpend`, tokens of `maxTokens`, each against the `spent` the caller counts for the record.
 */
export const leastLeft = (
  records: readonly ExecutionBudgetRecord[],
  cap: "maxSpend" | "maxTokens",
  spentOf: (record: ExecutionBudgetRecord) => Spend,
): number =>
  Math.min(
    ...records.flatMap((record) => {
      const limit = record[cap];
      return limit === undefined
        ? []
        : [limit - spentOf(record)[cap === "maxSpend" ? "usd" : "tokens"]];
    }),
    Number.POSITIVE_INFINITY,
  );

/** Micro-dollars in a dollar: the unit a budget's spend is compared in (#728). */
const MICRO_USD_PER_USD = 1_000_000;

/**
 * Whether `spent` has reached `maxSpend`, compared in whole micro-dollars (#728): a float sum of
 * costs lands a hair off its decimal value (eight $0.10 make 0.7999999999999999), and a plain
 * `>=` would let one more step through a limit the spend reached exactly. No epsilon: both sides
 * are rounded to the same grid, so a spend a micro-dollar under the limit still passes.
 */
export const isSpendExhausted = (spent: number, maxSpend: number): boolean =>
  Math.round(spent * MICRO_USD_PER_USD) >= Math.round(maxSpend * MICRO_USD_PER_USD);

/** Which cap of `record` the `spent` has reached (dollars first), or `undefined` when neither. */
export const exhaustedUnitOf = (
  record: ExecutionBudgetRecord,
  spent: Spend,
): BudgetUnit | undefined => {
  // a cap the record has not is an end no spend reaches
  if (isSpendExhausted(spent.usd, record.maxSpend ?? Number.POSITIVE_INFINITY))
    return BudgetUnit.Usd;
  if (spent.tokens >= (record.maxTokens ?? Number.POSITIVE_INFINITY)) return BudgetUnit.Tokens;
  return undefined;
};

/** The error of an exhausted budget. */
export const budgetExceededErrorOf = (
  record: ExecutionBudgetRecord,
  spent: Spend,
  unit: BudgetUnit,
  place: {
    readonly path: readonly string[];
    readonly executionSpent: number;
    readonly usage: readonly UsageRecord[];
  },
): LimitError.Budget =>
  new LimitError.Budget({
    budget: record.budget,
    scope: record.scope,
    period: record.period,
    key: record.key,
    unit,
    ...(record.maxSpend === undefined ? {} : { maxSpend: usd(record.maxSpend) }),
    spent: usd(Math.max(0, spent.usd)),
    ...(record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens }),
    usedTokens: Math.max(0, spent.tokens),
    path: place.path,
    spentUsd: usd(place.executionSpent),
    usage: place.usage,
  });

/**
 * A limit that is no finite amount from 0 — `NaN`, a word, an object, a negative number — would
 * never be reached by any spend (every comparison with `NaN` is false): the execution is refused
 * before its first step, whatever the source (a database, a file, the environment). The message
 * names the budget and the limit, never the value (#1373).
 */
function checkedLimit(budget: string, what: string, amount: unknown, whole: boolean): number {
  if (isFiniteNumber(amount) && amount >= 0 && (!whole || Number.isInteger(amount))) return amount;
  throw new ConfigError.Unit({
    message: `${budget}: ${what} must return a finite ${whole ? "whole number of tokens" : "number of dollars"} from 0${whole ? "" : " (usd(...))"}, it gave ${shownLimit(amount)}`,
  });
}

/** What `limit()` gave, or a limit-less budget: refused — an execution under no cap at all is never admitted (#1318). */
function checkedLimitsOf(budget: string, limit: BudgetLimit): BudgetLimit {
  const maxSpend = limit.maxSpend;
  const maxTokens = limit.maxTokens;
  if (maxSpend === undefined && maxTokens === undefined)
    throw new ConfigError.Unit({
      message: `${budget}: it gave no maxSpend and no maxTokens: a budget must limit something`,
    });
  return {
    ...(maxSpend === undefined
      ? {}
      : { maxSpend: usd(checkedLimit(budget, "maxSpend", maxSpend, false)) }),
    ...(maxTokens === undefined
      ? {}
      : { maxTokens: checkedLimit(budget, "maxTokens", maxTokens, true) }),
  };
}

/** The limits a budget declares in `@Budget({ maxSpend, maxTokens })`, an `env` value read from the process environment. */
function declaredLimitOf(meta: BudgetMeta): BudgetLimit | undefined {
  if (meta.maxSpend === undefined && meta.maxTokens === undefined) return undefined;
  const declared = { maxSpend: meta.maxSpend, maxTokens: meta.maxTokens };
  return resolveReferences(declared, process.env, `${meta.name} limits`);
}

/** The limits of a budget at the start of an execution: declared, or read from its `limit()` in the execution's frame. */
export async function limitsOf(
  handler: BudgetHandler,
  meta: BudgetMeta,
  inFrame: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<BudgetLimit> {
  const declared = declaredLimitOf(meta);
  if (declared !== undefined) return checkedLimitsOf(meta.name, declared);
  const { limit, maxSpend } = handler;
  if (limit !== undefined)
    return checkedLimitsOf(meta.name, await inFrame(() => Promise.resolve(limit.call(handler))));
  if (maxSpend === undefined)
    throw new ConfigError.Unit({
      message: `${meta.name}: it declares no maxSpend or maxTokens and has no limit()`,
    });
  const amount = await inFrame(() => Promise.resolve(maxSpend.call(handler)));
  return checkedLimitsOf(meta.name, {
    maxSpend: checkedLimit(meta.name, "maxSpend()", amount, false) as Usd,
  });
}

/** The limits a record keeps: what the ledger holds as the account's last known limits. */
export const limitOf = (record: ExecutionBudgetRecord): BudgetLimit => ({
  ...(record.maxSpend === undefined ? {} : { maxSpend: usd(record.maxSpend) }),
  ...(record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens }),
});

/** The first record `spentOf` says has reached a cap, as its `LimitError.Budget`; `undefined` when none has. */
export function firstBreachOf(
  records: readonly ExecutionBudgetRecord[],
  spentOf: (record: ExecutionBudgetRecord) => Spend,
  place: Parameters<typeof budgetExceededErrorOf>[3],
): LimitError.Budget | undefined {
  for (const record of records) {
    const spent = spentOf(record);
    const unit = exhaustedUnitOf(record, spent);
    if (unit !== undefined) return budgetExceededErrorOf(record, spent, unit, place);
  }
  return undefined;
}

/** What each record's counter holds in its current period, by the counter's key. */
export async function countersOf(
  ledger: CostLedgerRepository,
  records: readonly ExecutionBudgetRecord[],
  now: Date,
): Promise<ReadonlyMap<string, Spend>> {
  const values = new Map<string, Spend>();
  for (const record of records) {
    const counter = counterOf(record, now);
    values.set(counterKeyOf(counter), spendOfUsage(await ledger.findUsageByCounter(counter)));
  }
  return values;
}
