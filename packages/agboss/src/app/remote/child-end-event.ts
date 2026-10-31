import { ExecutionCancelledError } from "../../core/errors.js";
import type { ExecutionEndEvent } from "../../core/observability.js";
import type { ExecutionEvent } from "../../flow/observers/execution-event.js";
import { buildCostReport } from "../../finops/usage.js";
import type { RemoteChildRun } from "../../flow/runtime/remote/remote-child-run.js";
import type { ExecutionStateType } from "../../flow/runtime/state.js";
import { nodeRecordIn, workflowIdentityOf } from "../../flow/runtime/workflow-keys.js";
import type { GraphDeps } from "../../graph/deps.js";
import type {
  ChildExecutionEnd,
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";

/**
 * An `AnyInstance` child's finish, announced by its worker (#562): `onExecutionEnd` once its
 * completion of the child's queue row (`Answered`) won — the write that finishes the child. Its
 * parent, which only reads the row, never announces it, however often its step is re-entered (a
 * takeover, a recovery). A worker that stops between its completion and the announcement leaves it
 * unannounced: at most once, never twice. A child its worker stopped because its tree was cancelled
 * or ended, whose row went with the tree, is announced by that worker too (`onExecutionError`,
 * `ExecutionCancelledError`): no parent will ever read it. A failure whose row was completed is its
 * parent's to announce (`assertAnnouncing`, `child-failure.ts`), the undo running there.
 */

/** A claimed child's run on its worker: its workflow's deps, its row and its run. */
export interface ClaimedChild {
  readonly deps: GraphDeps<string>;
  readonly row: QueuedChildExecution;
  readonly run: RemoteChildRun;
}

/** What announcing a finished child needs: the claimed child and its last state. */
interface FinishedChild extends ClaimedChild {
  readonly last: ExecutionStateType;
}

/** A claimed child that ended cancelled: what stopped it. */
interface CancelledChild extends ClaimedChild {
  readonly error: ExecutionCancelledError;
}

/** The child's event identity: as its parent's step made it before #562. */
function eventOf({ deps, row, run }: ClaimedChild): ExecutionEvent {
  const { name, version, configHash } = workflowIdentityOf(deps);
  return {
    executionId: row.executionId,
    parentExecutionId: row.parentExecutionId,
    rootExecutionId: row.rootExecutionId,
    threadId: run.threadId,
    tenantId: row.tenantId,
    workflow: { name, version, startedVersion: version, configHash },
  };
}

/** The child's `onExecutionEnd` event. */
const childEndEventOf = (child: FinishedChild): ExecutionEndEvent => ({
  ...eventOf(child),
  finish: nodeRecordIn(child.deps, child.last.finish),
  spend: buildCostReport(child.last.usage.slice(child.run.initial.child.inheritedUsage)),
});

/** A claimed child's pass as its worker announces it: finished, or stopped by a cancel. */
export interface AnnouncedPass {
  readonly end: ChildExecutionEnd;
  readonly finished?: FinishedChild | undefined;
  readonly cancelled?: CancelledChild | undefined;
}

/**
 * Announces what the worker ended (see above): a finish whose completion won (`isCompleted`), a
 * cancel whose row went with its tree.
 */
export async function announcePass(
  queue: ChildExecutionQueueRepository,
  pass: AnnouncedPass,
  isCompleted: boolean,
): Promise<void> {
  if (isCompleted && pass.finished !== undefined)
    await pass.finished.deps.observer?.onExecutionEnd(childEndEventOf(pass.finished));
  const { cancelled } = pass;
  if (isCompleted || cancelled === undefined) return;
  const { tenantId, executionId } = cancelled.row;
  const row = await queue.findByTenantIdAndExecutionId(tenantId, executionId).catch(() => null);
  if (row !== undefined) return;
  const event = { ...eventOf(cancelled), error: cancelled.error, compensations: [] };
  await cancelled.deps.observer?.onExecutionError(event);
}

/** The cancellation a failed pass ended with, if that is what stopped it. */
export const cancelledOf = (child: ClaimedChild, cause: unknown): CancelledChild | undefined =>
  cause instanceof ExecutionCancelledError ? { ...child, error: cause } : undefined;
