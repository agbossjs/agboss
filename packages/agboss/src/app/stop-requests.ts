import { StatusTrigger, ThreadStatus, type NewStatusTransition } from "../turns/index.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { CancelParts } from "./cancel-requests.js";
import {
  CANCEL_REQUEST_KEY,
  InterruptKind,
  requestValueOf,
  type RequestValue,
} from "./interrupt-requests.js";
import type { InterruptMode } from "./interrupt-types.js";

/**
 * Writing a tree's stop request (#1341b), the one place every stop path does — the twin of
 * `writeCancelRequest`: the lease store's mark first (`requestStop`: the durable fence of an
 * `Immediate` stop on every instance, in the transaction of the thread's status-history row), then
 * the tree key the holder's watch, a lease taken over and the expiry look read. Both writes are
 * idempotent and both are made on every call: a stop asked again after a crash between the mark and
 * the key — or between the database's row and a coordination store's copy of it — completes it.
 */

/** The history row of a stop request: the thread is `Stopping` until its execution ends. */
export function stopTransitionOf(
  thread: { readonly tenantId: string; readonly threadId: string },
  request: { readonly ownerId: string | null; readonly reason?: string | undefined },
): NewStatusTransition {
  return {
    tenantId: thread.tenantId,
    threadId: thread.threadId,
    toStatus: ThreadStatus.Stopping,
    trigger: StatusTrigger.Stop,
    ...(request.ownerId === null ? {} : { actor: request.ownerId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}

/** Writes the stop request of `tree`; `mode` is how it reaches the step in flight. */
export async function writeStopRequest(
  parts: Pick<CancelParts, "leases" | "trees">,
  tree: ExecutionTree,
  request: RequestValue & { readonly mode: InterruptMode; readonly threadId?: string },
): Promise<void> {
  const { threadId, mode } = request;
  const transition =
    threadId === undefined ? undefined : stopTransitionOf({ ...tree, threadId }, request);
  await parts.leases.requestStop(tree, mode, transition);
  await parts.trees.saveIfAbsentInTree(
    tree,
    CANCEL_REQUEST_KEY,
    requestValueOf({ ...request, kind: InterruptKind.Stop }),
  );
}
