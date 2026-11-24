import { StatusTrigger, ThreadStatus, type NewStatusTransition } from "../turns/index.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { rootRecordOf } from "./ended-tree.js";
import { markedInterruptOf } from "./interrupt-requests.js";
import type { ExecutionLeases } from "./execution-leases.js";
import type { CancelParts } from "./cancel-requests.js";
import type { TreeState } from "./tree-move-types.js";
import { treeOf } from "./tree-ends.js";

/**
 * Whether the tree's cancel mark is on its lease row (#1152, #1117): the durable request itself,
 * written before the tree key, so a cancel that died between the two left only the mark. A store
 * error reads as none (asked again later).
 */
export async function isCancelMarked(
  leases: ExecutionLeases,
  tree: ExecutionTree,
): Promise<boolean> {
  // a cancel or a stop (#1341b): the marks that end a tree early, read from its lease row
  return (await markedInterruptOf(leases, tree)) !== undefined;
}

/** The statuses of a root whose tree is still alive: moving, or resting at its pause. */
const ALIVE: readonly string[] = [ExecutionRecordStatus.Running, ExecutionRecordStatus.Paused];

/**
 * Whether the tree's cancel mark is set and its root's record is not over: the mark is permanent
 * (#1117) and outlives the tree's end, so a take reads it only for a tree not yet ended — an ended
 * one has its end finished already (#1152).
 */
export async function isMarkedAlive(
  parts: Pick<CancelParts, "deps" | "leases">,
  state: TreeState,
): Promise<boolean> {
  if (!(await isCancelMarked(parts.leases, treeOf(state)))) return false;
  const record = await rootRecordOf(parts.deps, state).catch(() => undefined);
  return record !== undefined && ALIVE.includes(record.status);
}

/** The history row of a cancel request (#1341d): the thread is `Cancelling` until its undo ends. */
export function cancelTransitionOf(
  thread: { readonly tenantId: string; readonly threadId: string },
  request: { readonly ownerId: string | null; readonly reason?: string | undefined },
): NewStatusTransition {
  return {
    tenantId: thread.tenantId,
    threadId: thread.threadId,
    toStatus: ThreadStatus.Cancelling,
    trigger: StatusTrigger.Cancel,
    ...(request.ownerId === null ? {} : { actor: request.ownerId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}
