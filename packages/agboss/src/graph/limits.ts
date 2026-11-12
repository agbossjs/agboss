import { BudgetScope, type BudgetPeriod } from "../budgets/budget.js";
import { periodWords } from "../budgets/budget-period.js";
import { AGBossError } from "../core/errors.js";
import type { UsageRecord } from "../finops/usage.js";
import type { WorkflowRecord } from "../flow/context/execution-context.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { Usd } from "../units/index.js";

/**
 * The limit errors (#261 → Limit errors): one class per limit, all subclasses of
 * `LimitExceededError`, so `.onError(LimitExceededError, …)` catches any. Each names its limit as
 * the decorator does and the value reached, and its message reads as a sentence.
 */

/** What a limit error takes (#906): the limit, where the execution was, and its own sentence. */
export interface LimitExceededErrorOptions {
  /** What it is keyed by (`maxSteps`, the tenant `acme`, …). */
  readonly key: string;
  readonly limit: number;
  /** The value that crossed it. */
  readonly actual: number;
  readonly path: readonly string[];
  readonly spentUsd: number;
  /** Spend the execution's state does not hold yet; none by default. */
  readonly usage?: readonly UsageRecord[];
  /** A subclass's own sentence; a general one by default. */
  readonly message?: string;
  /** A subclass's own facts, kept in the error's record (an `ErrorDetails`). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * A limit was hit — the execution **fails** (never a quiet stop), with its path and its spend.
 * `usage` is spend the execution's state does not hold yet (an agent's loop stopped midway), so the
 * ledger still sees it. Its instance `code` is the union of the codes of its family (#906).
 */
export class LimitExceededError extends AGBossError {
  static override readonly code: string = "limit";
  declare readonly code:
    | "limit"
    | "limit.budget"
    | "limit.steps"
    | "limit.visits"
    | "limit.depth"
    | "limit.deadline"
    | "limit.mesh-loop"
    | "limit.hops";
  override name = "LimitExceededError";
  readonly key: string;
  readonly limit: number;
  readonly actual: number;
  readonly path: readonly string[];
  readonly spentUsd: number;
  readonly usage: readonly UsageRecord[];

  constructor(options: LimitExceededErrorOptions) {
    const { key, limit, actual, path, spentUsd, usage = [], message, details, cause } = options;
    super(
      message ??
        `Limit ${key} = ${String(limit)} exceeded (${String(actual)}); ` +
          `path: ${path.join(" → ")}; spent $${spentUsd.toFixed(4)}`,
      { cause, details: { key, limit, actual, ...details } },
    );
    this.key = key;
    this.limit = limit;
    this.actual = actual;
    this.path = path;
    this.spentUsd = spentUsd;
    this.usage = usage;
  }
}

/** `$40`, `$40.05`, `$0.0125`: up to four decimals, no trailing zeros. */
export const dollars = (amount: number): string => `$${amount.toFixed(4).replace(/\.?0+$/, "")}`;

/** What exhausted a budget: the budget, whose spend it counts, its limit and the spend reached. */
export interface BudgetBreach {
  /** The budget, by its `name` (no class: the error is kept on a plain record). */
  readonly budget: Pick<ComponentRecord, "name">;
  /** What the budget limits: an execution, a tenant or the application. */
  readonly scope: BudgetScope;
  /** The tenant and application budgets' period; none for an execution budget. */
  readonly period?: BudgetPeriod | undefined;
  /** The application's name, the `tenantId`, or the root execution's id. */
  readonly key: string;
  /** What `maxSpend()` gave at the start of the execution. */
  readonly maxSpend: Usd;
  /** What the budget's counter reached. */
  readonly spent: Usd;
}

/** What a budget error takes (#906): the breach, where the execution was, its spend. */
export interface BudgetExceededErrorOptions extends BudgetBreach {
  readonly path: readonly string[];
  readonly spentUsd: number;
  readonly usage?: readonly UsageRecord[];
  readonly cause?: unknown;
}

/** `tenant acme spent $40.05 today; tenant-daily-budget allows $40`. */
function budgetSentence(breach: BudgetBreach): string {
  const allows = `${breach.budget.name} allows ${dollars(breach.maxSpend)}`;
  const spent = dollars(breach.spent);
  const when = breach.period === undefined ? "" : ` ${periodWords(breach.period)}`;
  switch (breach.scope) {
    case BudgetScope.Tenant:
      return `tenant ${breach.key} spent ${spent}${when}; ${allows}`;
    case BudgetScope.Application:
      return `${breach.key} spent ${spent}${when}; ${allows}`;
    case BudgetScope.Execution:
      return `execution ${breach.key} spent ${spent}; ${allows}`;
  }
}

/**
 * A budget is exhausted (#261): the execution, its tenant's or the application's — checked before
 * the first step (the execution is rejected) and before every model call while it runs (the
 * execution stops). `budget` is compared with `nameOf(TenantDailyBudget)`.
 */
export class BudgetExceededError extends LimitExceededError {
  static override readonly code = "limit.budget" as const;
  declare readonly code: typeof BudgetExceededError.code;
  override name = "BudgetExceededError";
  /** The budget, compared with `nameOf(TenantDailyBudget)`. */
  readonly budget: ComponentRecord;
  /** What it limits: an execution, a tenant or the application. */
  readonly scope: BudgetScope;
  /** The tenant and application budgets' period; `undefined` for an execution budget. */
  readonly period: BudgetPeriod | undefined;
  /** The application's name, the `tenantId`, or the root execution's id. */
  override readonly key: string;
  /** What `maxSpend()` gave at the start of the execution. */
  readonly maxSpend: Usd;
  /** What the budget's counter reached. */
  readonly spent: Usd;

  constructor(options: BudgetExceededErrorOptions) {
    const { path, spentUsd, usage, cause, ...breach } = options;
    const { budget, scope, period, key, maxSpend, spent } = breach;
    super({
      key,
      limit: maxSpend,
      actual: spent,
      path,
      spentUsd,
      ...(usage === undefined ? {} : { usage }),
      cause,
      message: budgetSentence(breach),
      details: {
        budget: bareRecordOf(budget.name, ComponentKind.Budget),
        scope,
        key,
        maxSpend,
        spent,
      },
    });
    this.budget = bareRecordOf(budget.name, ComponentKind.Budget);
    this.scope = scope;
    this.period = period;
    this.key = key;
    this.maxSpend = maxSpend;
    this.spent = spent;
  }
}

/** What a steps limit error takes (#906). */
export interface StepsLimitExceededErrorOptions {
  readonly workflow: WorkflowRecord;
  readonly maxSteps: number;
  readonly path: readonly string[];
  readonly spentUsd: number;
  readonly cause?: unknown;
}

/** An execution took more agent and router steps than its workflow's `maxSteps` (#261). */
export class StepsLimitExceededError extends LimitExceededError {
  static override readonly code = "limit.steps" as const;
  declare readonly code: typeof StepsLimitExceededError.code;
  override name = "StepsLimitExceededError";
  readonly workflow: WorkflowRecord;
  readonly maxSteps: number;
  readonly steps: number;

  constructor(options: StepsLimitExceededErrorOptions) {
    const { workflow, maxSteps, path, spentUsd, cause } = options;
    const steps = maxSteps + 1;
    const record = {
      name: workflow.name,
      version: workflow.version,
      startedVersion: workflow.startedVersion,
      configHash: workflow.configHash,
    };
    super({
      key: "maxSteps",
      limit: maxSteps,
      actual: steps,
      path,
      spentUsd,
      cause,
      message: `${workflow.name} took ${String(steps)} steps; its maxSteps is ${String(maxSteps)}`,
      details: { workflow: record, maxSteps, steps },
    });
    this.workflow = record;
    this.maxSteps = maxSteps;
    this.steps = steps;
  }
}

/** A tenant's or the application's budget is exhausted (not one execution's): eval and replay stop there. */
export const isPeriodBudgetExhausted = (error: unknown): boolean =>
  error instanceof BudgetExceededError && error.scope !== BudgetScope.Execution;

/** Steps per execution by default: (agents + routers) × 3 (#261). */
export const STEPS_PER_WORKING_NODE = 3;
