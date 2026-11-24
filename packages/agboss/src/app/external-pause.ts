import { currentOutputOf } from "./current-output.js";
import type { ExecutionOutput } from "./types.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { treeOf } from "./tree-ends.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import { ExecutionError } from "../core/error-families/run-errors.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ExecutionLeases } from "./execution-leases.js";

/**
 * The tree is paused from outside (#1341c, `app.pause`) while a business pause (`@ExternalTask`,
 * `@ToolApproval`) is open: `dual_paused`. Nothing but `app.unpause` moves it — an answer is refused,
 * an expiry is deferred, the sweep's wake of an answered pause waits — so an operator's freeze is
 * never undone by a timer or an answer. The mark is the lease row's, read from the database whatever
 * the coordination store says (D6).
 */

/** Whether the tree's lease row carries an external pause; a store that fails rejects. */
export async function isExternallyPaused(
  leases: Pick<ExecutionLeases, "pauseOf">,
  tree: ExecutionTree,
): Promise<boolean> {
  return (await leases.pauseOf(tree)).pause !== undefined;
}

/**
 * `app.resume` of an answer on a tree frozen from outside is refused before it is recorded
 * (`ExecutionError.ExternallyPaused`): stage 1 of the resume, so the pause stays open and the answer
 * can be given again once the operator unpauses.
 */
export async function assertNotExternallyPaused(
  leases: Pick<ExecutionLeases, "pauseOf"> | undefined,
  tree: ExecutionTree,
): Promise<void> {
  if (leases === undefined || !(await isExternallyPaused(leases, tree))) return;
  throw new ExecutionError.ExternallyPaused({
    message:
      "the execution is paused from outside (app.pause): app.unpause(threadId) first, then answer its pause again",
  });
}

/**
 * A lease just taken for a tree frozen from outside (#1341c): nothing moves it. The answer that
 * brought the take — a channel's decision, an A2A or MCP answer — stays recorded (the pause
 * `Resolved`, never lost); the record its mark made `running` goes back to `paused`, so that no
 * recovery continues it and the sweep's wake (`answered-wake`) takes the answer once `app.unpause`
 * lifts the freeze — it resumes exactly once. The lease is released; `true` when the tree is frozen.
 */
export async function heldWhileFrozen(
  parts: Pick<TreeMoveParts, "deps" | "leases">,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<boolean> {
  if (!(await isExternallyPaused(parts.leases, treeOf(state)))) return false;
  try {
    const record = await parts.deps.turns.findByTenantIdAndRunId(state.tenantId, state.runId);
    if (record !== undefined)
      await parts.deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Running, {
        ...record,
        status: ExecutionRecordStatus.Paused,
      });
  } finally {
    await lease.release();
  }
  return true;
}

/** `heldWhileFrozen` for a resume: the output the tree rests with (still paused), or `undefined` when it is not frozen. */
export async function frozenOutputOf(
  parts: Pick<TreeMoveParts, "deps" | "leases" | "paused">,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<ExecutionOutput | undefined> {
  if (!(await heldWhileFrozen(parts, state, lease))) return undefined;
  return currentOutputOf(parts.deps, parts.paused, state);
}
