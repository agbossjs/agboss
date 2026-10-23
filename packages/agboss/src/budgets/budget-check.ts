import type { UsageRecord } from "../finops/usage.js";
import type { ExecutionDeadline } from "./execution-deadline.js";

/** What a check of an execution's budgets needs: no I/O, the counters as last read. */
export interface BudgetCheck {
  /** Throws the first exhausted budget's `BudgetExceededError`; `executionSpent` is the execution's total. */
  readonly check: (
    executionSpent: number,
    path: readonly string[],
    usage?: readonly UsageRecord[],
  ) => void;
  /**
   * Counts spend the moment it is made (#338), before it reaches the execution's state: every
   * branch of the pass sees it at its next check, and a tally that exhausts a budget aborts the
   * in-flight calls of the pass's launches.
   */
  readonly tally: (records: readonly UsageRecord[], path?: readonly string[]) => void;
  /** Aborted, with its `BudgetExceededError` as the reason, when a tally exhausts a budget. */
  readonly exhausted: AbortSignal;
  /**
   * What the execution may still spend, in USD — the least any of its budgets has left (#398: the
   * `budget.remaining` its mesh calls claim); `Infinity` without budgets.
   */
  readonly remaining?: () => number;
  /** The execution's deadline (#398 PR 2), when it has one: what its mesh calls claim of it. */
  readonly deadline?: ExecutionDeadline | undefined;
}

/** No budgets (an agent loop run on its own). */
export const NO_BUDGET_CHECK: BudgetCheck = {
  check: () => undefined,
  tally: () => undefined,
  exhausted: new AbortController().signal,
};
