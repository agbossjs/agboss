import { keyTextRuleOf } from "../core/errors.js";
import { checkedCallerId, treeRead } from "../flow/context/context-values.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { runConfig } from "../run/paused.js";
import { NotPausedError } from "../run/resume-agent.js";
import { readingGraphOf } from "../run/run-budgets.js";
import { InvalidThreadIdError } from "../run/thread.js";
import type { Tern } from "../terns/index.js";
import { CANCEL_REQUEST_KEY, type CancelParts } from "./cancel-requests.js";
import { cancelledPaused } from "./cancel-paused.js";
import { currentOutputOf } from "./current-output.js";
import { rootRecordOf } from "./ended-tree.js";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
  type DurableExecutionState,
  type ExecutionCancelRequest,
  type ExecutionTreeOfThread,
} from "./execution-control.js";
import { cancelledErrorOf, cancelledRecordOutcome, type LiveRuns } from "./live-runs.js";
import type { TreeState } from "./tree-move-types.js";
import { ExecutionStatus } from "./types.js";

/**
 * One execution tree of a workflow's app by its root execution id (#807, A2A design §4.1.5 and
 * §4.1.3 step 7, loaded on first use): where its durable records say it is, and a cancel of it alone.
 */

/** What reading and cancelling one tree needs from its workflow's app. */
export interface ExecutionTreeParts extends CancelParts {
  readonly live: LiveRuns;
}

const stateOf = (parts: CancelParts, tree: ExecutionTreeOfThread): TreeState => ({
  runId: tree.rootExecutionId,
  threadId: tree.threadId,
  tenantId: tree.tenantId,
  startedVersion: parts.deps.config.version,
});

/** A tree's key, checked as a key's text (tenant, root execution and thread), never echoed. */
async function checkedTree<T>(tree: ExecutionTreeOfThread, read: () => Promise<T>): Promise<T> {
  return treeRead(tree, () => {
    const rule = keyTextRuleOf(tree.threadId);
    if (rule !== undefined) throw new InvalidThreadIdError(rule);
    return read();
  });
}

/**
 * Whether a failed record says its execution was cancelled — by the reasons the framework writes
 * itself (`cancelledErrorOf`, `cancelledRecordOutcome`), never by reading free text.
 */
const isCancelledRecord = (record: Tern, threadId: string): boolean =>
  record.stopReason === cancelledErrorOf(threadId).message ||
  record.stopReason === cancelledRecordOutcome([], 0).stopReason;

/** Whether the tree's own checkpoint thread (its root execution id) has a checkpoint. */
async function hasCheckpoint(parts: CancelParts, runId: string): Promise<boolean> {
  const snapshot = await readingGraphOf(parts.deps).getState(runConfig(runId));
  return snapshot.createdAt !== undefined;
}

/** What a tree's own record says when it runs or failed; `undefined` for any other record. */
function recordStateOf(
  record: Tern | undefined,
  threadId: string,
): DurableExecutionState | undefined {
  switch (record?.status) {
    case ExecutionRecordStatus.Running:
      return { status: DurableExecutionStatus.Running };
    case ExecutionRecordStatus.Failed:
    case ExecutionRecordStatus.Guarded:
      return isCancelledRecord(record, threadId)
        ? { status: DurableExecutionStatus.Cancelled }
        : { status: DurableExecutionStatus.Failed, reason: record.stopReason };
    default:
      return undefined;
  }
}

/** Its paused run, else its last checkpoint at a finish; `undefined` when it is at neither. */
async function restStateOf(
  parts: CancelParts,
  state: TreeState,
): Promise<DurableExecutionState | undefined> {
  try {
    const output = await currentOutputOf(parts.deps, parts.paused, state);
    return output.status === ExecutionStatus.Paused
      ? { status: DurableExecutionStatus.Paused, pending: output.pending }
      : {
          status: DurableExecutionStatus.Finished,
          finish: output.finish?.name ?? "",
          output: output.output,
        };
  } catch (error) {
    if (error instanceof NotPausedError) return undefined;
    throw error;
  }
}

/**
 * Where a tree is from its durable records: its record on its thread (a failure, a cancel, a run),
 * else its paused run or its last checkpoint (the finish and its output, read whatever record window
 * the thread's later turns left), else whether any checkpoint shows it began.
 */
export async function executionStateOf(
  parts: CancelParts,
  tree: ExecutionTreeOfThread,
): Promise<DurableExecutionState> {
  return checkedTree(tree, async () => {
    const state = stateOf(parts, tree);
    const record = await rootRecordOf(parts.deps, state);
    const known = recordStateOf(record, tree.threadId) ?? (await restStateOf(parts, state));
    if (known !== undefined) return known;
    const isBegun = record !== undefined || (await hasCheckpoint(parts, tree.rootExecutionId));
    return { status: isBegun ? DurableExecutionStatus.Running : DurableExecutionStatus.NotStarted };
  });
}

/**
 * Cancels one tree (#807): its cancel request (#360) saved in that tree first — so a tree that has
 * not started yet stops before its first step when it does —, then its run here aborted, or its
 * paused run ended here, or its holder elsewhere left to read the request at its next renewal; a
 * tree already over has its request withdrawn. Another run of its thread is never touched.
 */
export async function cancelExecution(
  parts: ExecutionTreeParts,
  request: ExecutionCancelRequest,
): Promise<ExecutionCancelOutcome> {
  return checkedTree(request, async () => {
    checkedCallerId("ExecutionCancelRequest", "ownerId", request.ownerId); // #589
    const { trees, clock, live } = parts;
    const tree = { tenantId: request.tenantId, rootExecutionId: request.rootExecutionId };
    const requestedAt = clock.now().toISOString();
    await trees.saveIfAbsentInTree(tree, CANCEL_REQUEST_KEY, {
      requestedAt,
      ownerId: request.ownerId ?? null,
    });
    if (live.abortExecution(tree, request.threadId)) return ExecutionCancelOutcome.Aborted;
    const durable = await executionStateOf(parts, request);
    switch (durable.status) {
      case DurableExecutionStatus.Paused: {
        const thread = { tenantId: request.tenantId, threadId: request.threadId };
        // moved on meanwhile (a resume took it): its holder reads the request
        return (await cancelledPaused(parts, thread, request.rootExecutionId))
          ? ExecutionCancelOutcome.Ended
          : ExecutionCancelOutcome.Requested;
      }
      case DurableExecutionStatus.Running:
        return ExecutionCancelOutcome.Requested;
      case DurableExecutionStatus.NotStarted:
        return ExecutionCancelOutcome.AwaitingStart;
      default:
        // it ended between the request and now: the request goes with the tree's keys
        await trees.deleteAllInTree(tree);
        return ExecutionCancelOutcome.AlreadyOver;
    }
  });
}
