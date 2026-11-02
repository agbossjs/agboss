import type { Clock } from "../infrastructure/clock.js";
import type { Class } from "../components/injection.js";
import type { CostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { budgetOf, BudgetScope, type BudgetHandler, type BudgetMeta } from "./budget.js";

export { NO_BUDGET_CHECK, type BudgetCheck } from "./budget-check.js";

/**
 * Budgets at run time (#261 PR 5): which budgets an execution has — its own workflow's execution
 * budget (else the default one), every tenant budget and every application budget —, their
 * `maxSpend()` read once, at its start, and kept for the whole execution (in its state, so a resume
 * or a recovery keeps them), the ledger checked before the first step (any exhausted → the
 * execution is rejected) and every model call's cost counted in all of them, the first exhausted
 * stopping the execution with `BudgetExceededError`. Nothing is reserved: parallel executions of one
 * tenant may overrun a little on a race, and a budget may be exceeded by at most the calls in flight
 * when it was exhausted (#338: the pass's live tally aborts them), plus (#664) the spend of the steps
 * it never holds back (the undos, automatic or a side path's; the actions of the side path that took
 * a limit, step by step) and, across instances, what other trees' steps spend that start before
 * that spend is in the ledger — at the end of the superstep that spent it.
 */

/** A budget class with what `@Budget` says of it. */
interface ListedBudget {
  readonly type: Class;
  readonly meta: BudgetMeta;
}

/** An application's budgets, as one workflow of it runs them. */
export interface ApplicationBudgets {
  /** Every `@Budget` the application lists. */
  readonly budgets: readonly Class[];
  /** The application's name: the key of its application budgets. */
  readonly applicationName: string;
  /** The budget instance (the container's, or a test's mock). */
  readonly resolve: (budget: Class) => BudgetHandler;
  readonly ledger: CostLedgerRepository;
  /** The application's `Clock` (#262): the period a call is counted in. */
  readonly clock: Clock;
}

const listed = (budgets: readonly Class[]): readonly ListedBudget[] =>
  budgets.flatMap((type) => {
    const meta = budgetOf(type);
    return meta === undefined ? [] : [{ type, meta }];
  });

/**
 * The budgets of an execution of `workflow` started directly: its own execution budget (else the
 * default one), every tenant budget, every application budget — in the order listed.
 */
export function budgetsOfExecution(
  budgets: readonly Class[],
  workflow: Class,
): readonly ListedBudget[] {
  const all = listed(budgets);
  const execution = all.filter((budget) => budget.meta.scope === BudgetScope.Execution);
  const own = execution.find((budget) => budget.meta.workflow === workflow);
  const chosen = own ?? execution.find((budget) => budget.meta.workflow === undefined);
  return all.filter((budget) => budget.meta.scope !== BudgetScope.Execution || budget === chosen);
}

/** Whose spend an execution's budget counts. */
export interface ExecutionKeys {
  readonly applicationName: string;
  readonly tenantId: string;
  readonly executionId: string;
}

/** The key of a budget of `scope`: the application's name, the `tenantId` or the execution's id. */
export const budgetKeyOf = (scope: BudgetScope, keys: ExecutionKeys): string =>
  scope === BudgetScope.Application
    ? keys.applicationName
    : scope === BudgetScope.Tenant
      ? keys.tenantId
      : keys.executionId;

export {
  accountOf,
  budgetExceededErrorOf,
  counterOf,
  type ExecutionBudgetRecord,
} from "./budget-counters.js";
export { BudgetMeter, meterOf } from "./budget-meter.js";
