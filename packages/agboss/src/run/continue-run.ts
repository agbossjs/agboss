import type { ExecutionBudgetRecord } from "../budgets/execution-budgets.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import { startLine } from "../flow/runtime/history.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { failedOutcome, outcomeError, recordFailure, type TernBase } from "./execute.js";
import { continuedExecutionBudgets, recorder } from "./run-budgets.js";
import { finishRun } from "./finish.js";
import { streamConfig } from "./stream-config.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "./types.js";
import { runVersions } from "./versions.js";

/** What continuing an execution needs to know of it: its ids, record, start, budget and spend so far. */
export interface ContinuedRun {
  readonly runId: string;
  readonly threadId: string;
  /** The tenant of its thread (#261); its context values come back from its checkpoint. */
  readonly tenantId: string;
  /** Its record (a Tern), completed when this pass ends. */
  readonly ternId: string;
  readonly start: string;
  readonly startInput: unknown;
  readonly budgetUsd: number;
  /** Its budgets, as it keeps them in its state (the amounts read at its start). */
  readonly budgets: readonly ExecutionBudgetRecord[] | undefined;
  /** What it spent before this pass, already in the ledger. */
  readonly spent: readonly UsageRecord[];
  /** The resolved pauses this pass answers (a resume's); none for a recovery. */
  readonly takenPauseIds?: ReadonlySet<string>;
}

/** Streams the pass, recording spend as it happens; returns the last state. */
export type ContinuedPass = (
  graph: ExecutionGraph,
  streaming: ReturnType<typeof streamConfig>,
  record: (records: readonly UsageRecord[]) => Promise<void>,
) => Promise<ExecutionStateType>;

export type ContinueOptions = Omit<RunOptions, "replayOf" | "runId" | "contexts">;

/**
 * One more pass of an execution that already ran (a resume with its decision, or recovery from
 * its last checkpoint, #265 S30): same run id, same record, the same budgets — the amounts read at
 * its start, their counters read anew. Spend recorded before is not recorded again; a failure
 * completes the record.
 */
export async function continueRun<TName extends string>(
  run: ContinuedRun,
  deps: RunDeps<TName>,
  options: ContinueOptions,
  pass: ContinuedPass,
): Promise<AgentExecutionOutput> {
  const spent: UsageRecord[] = [];
  const budgets = await continuedExecutionBudgets(deps, run.budgets, totalCost(run.spent));
  const graph = executionGraphOf(deps, { budgets: budgets.meter });
  const record = recorder(budgets.meter, spent);
  const base: TernBase = {
    runId: run.runId,
    threadId: run.threadId,
    tenantId: run.tenantId,
    bundle: deps.config.name,
    task: startLine(run.start, run.startInput),
    replayOf: null,
    ...runVersions(deps),
  };
  try {
    const { threadId, tenantId, runId } = run;
    const identity = { threadId, tenantId, runId, input: run.startInput };
    const streaming = streamConfig(deps, identity, options);
    const state = await pass(graph, streaming, record);
    const context = {
      deps,
      graph,
      base,
      runId: run.runId,
      budgetUsd: run.budgetUsd,
      record,
      recorded: [...run.spent, ...spent],
      takenPauseIds: run.takenPauseIds,
      callbacks: streaming.callbacks,
    };
    return await finishRun(context, state, run.ternId);
  } catch (error) {
    const cause = outcomeError(error, options.signal);
    throw await recordFailure(cause, () =>
      deps.terns.complete(run.ternId, failedOutcome(cause, [...run.spent, ...spent])),
    );
  }
}
