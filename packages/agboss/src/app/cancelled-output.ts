import { CostReport, type UsageRecord } from "../finops/usage.js";
import { compensationRecordsOf, type CompensationRecord } from "../flow/compensation.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import type { AppDeps } from "./app-deps.js";
import { checkpointStateOf, EMPTY_STATE, type RecordedState } from "./execution-history.js";
import type { TreeState } from "./tree-move-types.js";
import { traceUrlFieldOf } from "../tracing/trace-url.js";
import { isStop, reasonOfError } from "./interrupt-requests.js";
import {
  ExecutionStatus,
  type CancelledExecutionOutput,
  type ExecutionOutput,
  type StoppedExecutionOutput,
} from "./types.js";

/**
 * The outcome of a cancelled execution (#1341): a cancel is an operator's decision, not a failure,
 * so `app.execute`, `app.resume` and `app.cancel`'s run resolve with `ExecutionStatus.Cancelled`
 * instead of rejecting. Built from the tree's last checkpoint once its undo ran, so what it spent
 * and what it undid are reported whichever instance ended it.
 */

/** What a cancelled tree is reported with. */
export interface CancelledEnd {
  /** The cancel the tree ended with: what its record and the pauses it closes name. */
  readonly cause: Error;
  /** What its undo ran, when that is not all in the checkpoint (#635). */
  readonly compensations?: readonly CompensationRecord[] | undefined;
  /** Calls the checkpoint does not hold: a lost run's of unknown cost (#860). */
  readonly lostUsage?: readonly UsageRecord[] | undefined;
}

/** The cancel each cancelled output was built for: the tree's record and its pauses' end read it. */
const causes = new WeakMap<object, Error>();

/** The cancel `output` was built for; `undefined` for any other output. */
export const cancelCauseOf = (output: ExecutionOutput): Error | undefined => causes.get(output);

/** The tree's checkpoint; one that cannot be read is a warning and an empty one. */
async function checkpointOf(deps: AppDeps, state: TreeState): Promise<RecordedState> {
  try {
    return await checkpointStateOf(deps, state);
  } catch (error) {
    const text = `the checkpoint of cancelled execution ${state.runId} could not be read: ${String(error)}`;
    deps.log.warn("execution.cancelled-checkpoint-unread", text, {
      executionId: state.runId,
      tenantId: state.tenantId,
    });
    return EMPTY_STATE;
  }
}

/**
 * The cancelled output of `state`'s tree. A checkpoint that cannot be read (its store failing right
 * after the tree's end became durable) never turns the cancel into a rejection: the output then
 * lists only what the end itself knows.
 */
export async function cancelledOutputOf(
  deps: AppDeps,
  state: TreeState,
  end: CancelledEnd,
): Promise<CancelledExecutionOutput | StoppedExecutionOutput> {
  const values = await checkpointOf(deps, state);
  const isStopped = isStop(end.cause);
  const reason = reasonOfError(end.cause);
  const output: CancelledExecutionOutput | StoppedExecutionOutput = {
    // a stop is an outcome of its own (#1341b): the same report, nothing undone
    status: isStopped ? ExecutionStatus.Stopped : ExecutionStatus.Cancelled,
    ...(reason === undefined ? {} : { reason }),
    threadId: state.threadId,
    tenantId: state.tenantId,
    executionId: state.runId,
    path: values.path,
    spend: CostReport.fromUsage([...values.usage, ...(end.lostUsage ?? [])]),
    launches: values.launches,
    children: withChildPauses(values.children, []),
    handledErrors: values.handledErrors,
    compensations: end.compensations ?? compensationRecordsOf(values.compensations),
    toolCalls: values.toolCalls,
    pending: [],
    ...traceUrlFieldOf(deps.tracing, {
      workflow: deps.config.name,
      threadId: state.threadId,
      tenantId: state.tenantId,
      runId: state.runId,
    }),
  };
  causes.set(output, end.cause);
  return output;
}
