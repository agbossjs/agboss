import { BudgetScope, type BudgetUnit, type BudgetPeriod } from "../budgets/budget.js";
import { LimitError } from "../core/error-families/limit-errors.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { Usd } from "../units/index.js";

export { dollars } from "../core/error-families/limit-error-specs.js";

/**
 * The limit errors (#261 → Limit errors, #1325b): the variants of `LimitError`, so
 * `.onError(LimitError, …)` catches any. Each names its limit as the decorator does and the value
 * reached, and its message reads as a sentence.
 */

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
  /** What was reached: the dollar cap or the token cap (#1318); dollars when a budget has both and both are reached. */
  readonly unit?: BudgetUnit;
  /** The dollar cap read at the start of the execution; absent for a token-only budget. */
  readonly maxSpend?: Usd;
  /** What the budget's counter reached, in dollars. */
  readonly spent: Usd;
  /** The token cap read at the start of the execution; absent for a USD-only budget. */
  readonly maxTokens?: number;
  /** The tokens the budget's counter reached. */
  readonly usedTokens?: number;
}

/** A tenant's or the application's budget is exhausted (not one execution's): eval and replay stop there. */
export const isPeriodBudgetExhausted = (error: unknown): boolean =>
  error instanceof LimitError.Budget && error.scope !== BudgetScope.Execution;

/** Steps per execution by default: (agents + routers + actions + external tasks) × 3 (#261, #1278). */
export const STEPS_PER_WORKING_NODE = 3;
