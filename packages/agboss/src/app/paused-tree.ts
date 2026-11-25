import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ExecutionLeases } from "./execution-leases.js";
import type { InterruptMode } from "./interrupt-types.js";
import { ExecutionPausedError } from "./lease-stopped.js";

/** What a holder aborts its run with when its tree is paused from outside (#1341c); the reason rides in `details`. */
export const pausedErrorOf = (threadId: string, reason?: string): ExecutionPausedError =>
  new ExecutionPausedError({
    message: `thread "${threadId}" was paused`,
    ...(reason === undefined ? {} : { details: { reason } }),
  });

/**
 * The pause of a tree as its lease row holds it — the database is the authority (D6): how it
 * reaches a step in flight and the error to stop it with; `undefined` when the tree is not paused or
 * the store does not answer (asked again at the next look: a read that fails never parks a run).
 */
export async function pausedTreeOf(
  leases: Pick<ExecutionLeases, "pauseOf"> | undefined,
  tree: ExecutionTree,
  threadId: string,
): Promise<{ readonly mode: InterruptMode; readonly error: ExecutionPausedError } | undefined> {
  const marks = await leases?.pauseOf(tree).catch(() => undefined);
  if (marks?.pause === undefined) return undefined;
  return { mode: marks.pause.mode, error: pausedErrorOf(threadId, marks.pause.reason) };
}
