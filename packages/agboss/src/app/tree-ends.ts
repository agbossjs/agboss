import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { AppDeps } from "./app-deps.js";
import type { LiveRuns } from "./live-runs.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { LeasedCheckpointSaver } from "./leased-checkpointer.js";
import { withdrawPauses } from "./paused-runs.js";
import type { TreeMoveParts, TreeState } from "./tree-moves.js";

/** The tree's key in the stores: its tenant and its root execution. */
export const treeOf = (state: TreeState): ExecutionTree => ({
  tenantId: state.tenantId,
  rootExecutionId: state.runId,
});

/** The run deps of one pass: its checkpoint writes renew the tree's lease first. */
export const leasedDeps = (deps: AppDeps, lease: HeldExecutionLease): AppDeps =>
  deps.pause === undefined
    ? deps
    : {
        ...deps,
        pause: {
          ...deps.pause,
          checkpointer: new LeasedCheckpointSaver(deps.pause.checkpointer, lease),
        },
      };

/** What forgetting an ended tree needs from its workflow's app. */
export type TreeEndParts = Pick<TreeMoveParts, "deps" | "trees" | "clock">;

/**
 * The tree ended (finished, failed, cancelled): its keys removed — a cancel request among them —
 * and its waiting pauses withdrawn (#267 AC10).
 */
export async function forgetTree(parts: TreeEndParts, state: TreeState): Promise<void> {
  await parts.trees.deleteAllInTree(treeOf(state));
  // its queued children (#333 PR 2): a worker still running one stops at its next look
  await parts.deps.remoteChildren?.queue.deleteAllByTenantIdAndRootExecutionId(
    state.tenantId,
    state.runId,
  );
  parts.deps.branchErrors?.forgetExecution(state.runId);
  const { pause } = parts.deps;
  if (pause !== undefined) await withdrawPauses(pause, treeOf(state), parts.clock.now());
}

/**
 * A pass of the tree ended (#367, #340): its step bodies still running awaited (while the instance
 * stops), and its undoable actions' in-process mirror forgotten — they live on in its checkpoint.
 */
export async function passEnded(
  live: Pick<LiveRuns, "stepsClosed">,
  deps: Pick<AppDeps, "stepEntries" | "compensation">,
  state: TreeState,
): Promise<void> {
  await live.stepsClosed(treeOf(state), deps.stepEntries);
  deps.compensation?.registry.forget(treeOf(state));
}
