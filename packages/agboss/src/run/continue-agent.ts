import { AGBossError, type MessageErrorOptions } from "../core/errors.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { continueRun, type ContinueOptions } from "./continue-run.js";
import { drainRun, failedOutcome } from "./execute.js";
import { hasGraphEnded } from "./graph-end.js";
import { readingGraphOf } from "./run-budgets.js";
import { runConfig } from "./paused.js";
import type { AgentExecutionOutput, AgentExecutionDeps } from "./types.js";

/** The record of an interrupted execution recovery continues: its run, thread, tenant and record id. */
export interface InterruptedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly turnId: string;
  /** The workflow version it started on (its record's). */
  readonly startedVersion: string;
}

/**
 * An interrupted execution with nothing to continue from: it stopped before its first checkpoint
 * (its start input was never saved), so its record is completed as failed.
 */
export class NothingToRecoverError extends AGBossError {
  static override readonly code = "execution.nothing-to-recover" as const;
  declare readonly code: typeof NothingToRecoverError.code;
  override name = "NothingToRecoverError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** The channel LangGraph's hidden first task reads the run's input from. */
const START_CHANNEL = "__start__";

/**
 * Whether the checkpoint holds the run's input but not its effect: the state channels still hold
 * their defaults (an empty `start`) because the first task's writes were not saved.
 */
export const isInitialUnapplied = (values: Partial<ExecutionStateType>): boolean =>
  values.start === "";

/** `values` with the run's initial state (what its first `stream` was given) laid over the defaults. */
export function withInitial(
  values: Partial<ExecutionStateType>,
  initial: Partial<ExecutionStateType> | undefined,
): Partial<ExecutionStateType> {
  return initial === undefined ? values : { ...values, ...initial };
}

/** The initial state the run was started with, as its first checkpoint keeps it; none when it has none. */
async function initialOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  runId: string,
): Promise<Partial<ExecutionStateType> | undefined> {
  const saver = readingGraphOf(deps).checkpointer;
  if (typeof saver !== "object") return undefined;
  const tuple = await saver.getTuple(runConfig(runId));
  const initial: unknown = tuple?.checkpoint.channel_values[START_CHANNEL];
  // LangGraph boundary: the channel holds the update the run was started with
  return typeof initial === "object" && initial !== null
    ? (initial as Partial<ExecutionStateType>)
    : undefined;
}

/**
 * Continues an execution its instance left mid-step (#265 S30) from its last checkpoint: the
 * steps that finished keep their writes, only the interrupted one runs again — same run id, same
 * record, the same budgets. A tree whose graph had already finished (the instance
 * died before writing the record) is only finished — finished is the graph's end (no task left at
 * its checkpoint), never an empty `next` (#1090): a task whose writes were saved but whose next
 * checkpoint was not is applied and the steps after it run, once.
 */
export async function continueAgent<TName extends string>(
  interrupted: InterruptedRun,
  deps: AgentExecutionDeps<TName>,
  options: ContinueOptions = {},
): Promise<AgentExecutionOutput> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(interrupted.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const read = snapshot.values as Partial<ExecutionStateType>;
  // saved before the hidden start task's writes (#1090): its input is still in the checkpoint's `__start__` channel
  const before = isInitialUnapplied(read)
    ? withInitial(read, await initialOf(deps, interrupted.runId))
    : read;
  if (before.start === undefined || before.start === "" || before.usage === undefined) {
    const error = new NothingToRecoverError({
      message: `execution ${interrupted.runId} stopped before its first checkpoint: nothing to continue`,
    });
    await deps.turns.complete(interrupted.turnId, failedOutcome(error, []));
    throw error;
  }
  const spent = before.usage;
  const run = {
    ...interrupted,
    start: before.start,
    startInput: before.startInput,
    budgetUsd: before.budgetUsd ?? 0,
    budgets: before.budgets,
    deadline: before.contexts?.deadline,
    spent,
  };
  return continueRun(run, deps, options, async (moving, streaming, record) =>
    hasGraphEnded(snapshot)
      ? (before as ExecutionStateType)
      : drainRun(await moving.stream(null, streaming), record, spent),
  );
}
