import { BudgetScope, type BudgetPeriod } from "../budgets/budget.js";
import { periodWords } from "../budgets/budget-period.js";
import { AGBossError, type ErrorDetails } from "../core/errors.js";
import type { UsageRecord } from "../finops/usage.js";
import type { WorkflowRecord } from "../flow/context/execution-context.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { Usd } from "../units/index.js";

/**
 * The limit errors (#261 → Limit errors): one class per limit, all subclasses of
 * `LimitExceededError`, so `.onError(LimitExceededError, …)` catches any. Each names its limit as
 * the decorator does and the value reached, and its message reads as a sentence.
 */

/** What hit a limit: what it is keyed by (`maxSteps`, the tenant `acme`, …), the limit and the value that crossed it. */
export interface LimitBreach {
  readonly key: string;
  readonly limit: number;
  readonly actual: number;
}

/** A subclass's own sentence and facts (`VisitsLimitExceededError`). */
export interface LimitErrorText {
  readonly message: string;
  readonly details: ErrorDetails;
}

/**
 * A limit was hit — the execution **fails** (never a quiet stop), with its path and its spend.
 * `usage` is spend the execution's state does not hold yet (an agent's loop stopped midway), so the
 * ledger still sees it.
 */
export class LimitExceededError extends AGBossError {
  static override readonly code: string = "limit";
  override name = "LimitExceededError";
  readonly key: string;
  readonly limit: number;
  readonly actual: number;
  readonly path: readonly string[];
  readonly spentUsd: number;
  readonly usage: readonly UsageRecord[];

  constructor(
    breach: LimitBreach,
    path: readonly string[],
    spentUsd: number,
    usage: readonly UsageRecord[] = [],
    text?: LimitErrorText,
  ) {
    super(
      text?.message ??
        `Limit ${breach.key} = ${String(breach.limit)} exceeded (${String(breach.actual)}); ` +
          `path: ${path.join(" → ")}; spent $${spentUsd.toFixed(4)}`,
      {
        details: { key: breach.key, limit: breach.limit, actual: breach.actual, ...text?.details },
      },
    );
    this.key = breach.key;
    this.limit = breach.limit;
    this.actual = breach.actual;
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
  static override readonly code: string = "limit.budget";
  override name = "BudgetExceededError";
  /** The budget, compared with `nameOf(TenantDailyBudget)`. */
  readonly budget: ComponentRecord;
  /** What it limits: an execution, a tenant or the application. */
  readonly scope: BudgetScope;
  /** The application's name, the `tenantId`, or the root execution's id. */
  override readonly key: string;
  /** What `maxSpend()` gave at the start of the execution. */
  readonly maxSpend: Usd;
  /** What the budget's counter reached. */
  readonly spent: Usd;

  constructor(
    breach: BudgetBreach,
    path: readonly string[],
    spentUsd: number,
    usage: readonly UsageRecord[] = [],
  ) {
    const { budget, scope, key, maxSpend, spent } = breach;
    super({ key, limit: maxSpend, actual: spent }, path, spentUsd, usage, {
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
    this.key = key;
    this.maxSpend = maxSpend;
    this.spent = spent;
  }
}

/** An execution took more agent and router steps than its workflow's `maxSteps` (#261). */
export class StepsLimitExceededError extends LimitExceededError {
  static override readonly code: string = "limit.steps";
  override name = "StepsLimitExceededError";
  readonly workflow: WorkflowRecord;
  readonly maxSteps: number;
  readonly steps: number;

  constructor(
    workflow: WorkflowRecord,
    maxSteps: number,
    path: readonly string[],
    spentUsd: number,
  ) {
    const steps = maxSteps + 1;
    const record = {
      name: workflow.name,
      version: workflow.version,
      startedVersion: workflow.startedVersion,
      configHash: workflow.configHash,
    };
    super({ key: "maxSteps", limit: maxSteps, actual: steps }, path, spentUsd, [], {
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
