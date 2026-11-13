import type { GraphDeps } from "../graph/deps.js";
import type {
  ExecutionTree,
  ExecutionTreeRepository,
} from "../infrastructure/execution-tree.repository.js";
import { withoutRecoveryOf } from "./tree-control.js";
import type { AppDeps } from "./app-deps.js";
import type { LiveRuns } from "./live-runs.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { LeasedCheckpointSaver } from "./leased-checkpointer.js";
import { closeTreePauses } from "./tree-end-pauses.js";
import type { TreeMoveParts, TreeState } from "./tree-moves.js";

/** The tree's key in the stores: its tenant and its root execution. */
export const treeOf = (state: TreeState): ExecutionTree => ({
  tenantId: state.tenantId,
  rootExecutionId: state.runId,
});

/**
 * The graph deps of one pass: checkpoint writes renew `lease`, remote child waits yield it (#333 PR
 * 4), its steps fence with it (#471).
 */
export function leasedGraphDeps<TName extends string>(
  deps: GraphDeps<TName>,
  lease: HeldExecutionLease,
): GraphDeps<TName> {
  if (deps.pause === undefined) return { ...deps, lease };
  const { pause, remoteChildren, childDepsOf } = deps;
  return {
    ...deps,
    lease,
    pause: {
      ...pause,
      checkpointer: new LeasedCheckpointSaver(pause.checkpointer, lease),
    },
    ...(remoteChildren === undefined
      ? {}
      : {
          remoteChildren: {
            ...remoteChildren,
            yieldWhile: (wait) => lease.yieldWhile(wait),
          },
        }),
    ...(childDepsOf === undefined
      ? {}
      : {
          childDepsOf: (workflow) => {
            const child = childDepsOf(workflow);
            return child === undefined ? undefined : leasedGraphDeps(child, lease);
          },
        }),
  };
}

/** The run deps of one pass: its checkpoint writes renew the tree's lease first. */
export const leasedDeps = (deps: AppDeps, lease: HeldExecutionLease): AppDeps =>
  leasedGraphDeps(deps, lease) as AppDeps;

/** Why a tree that finished closes a pause it still had (none in practice, I13). */
const TREE_FINISHED = new Error("the tree finished");

/** What forgetting an ended tree needs from its workflow's app. */
export type TreeEndParts = Pick<TreeMoveParts, "deps" | "trees" | "clock">;

/**
 * The tree ended (finished, failed, cancelled): its keys removed — a cancel request among them —
 * and its pauses closed last (#267 AC10, #939): the reason follows `end`. Idempotent, so the orphan
 * look runs it again for a tree whose instance died in the middle. The root's record is terminal
 * before this runs — never earlier: the cancel request goes with the keys, and a recovery of a
 * still `running` root would run a cancelled tree's pass again (#901's class).
 */
export async function forgetTree(
  parts: TreeEndParts,
  state: TreeState,
  cause: unknown = TREE_FINISHED,
): Promise<void> {
  await parts.trees.deleteAllInTree(treeOf(state));
  // its queued children (#333 PR 2): a worker still running one stops at its next look
  await parts.deps.remoteChildren?.queue.deleteAllByTenantIdAndRootExecutionId(
    state.tenantId,
    state.runId,
  );
  parts.deps.branchErrors?.forgetExecution(state.runId);
  const { pause } = parts.deps;
  if (pause === undefined) return;
  const ends = { stores: pause };
  const site = { ...treeOf(state), threadId: state.threadId };
  const end = { cause: cause instanceof Error ? cause : new Error(String(cause)) };
  await closeTreePauses(ends, site, end, parts.clock.now());
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

/**
 * The reserved tree key of a run no recovery continues: written before its first pass, read only by
 * an instance taking its lease over (`cancel-requests.ts`), gone with the tree's keys.
 */
export const WITHOUT_RECOVERY_KEY = "@agboss/without-recovery";

/** Marks a new root's tree as no recovery's to continue when its call asks so, before its first pass. */
export async function markedIfWithoutRecovery(
  call: object,
  trees: Pick<ExecutionTreeRepository, "saveIfAbsentInTree">,
  tree: ExecutionTree,
): Promise<void> {
  const mark = withoutRecoveryOf(call);
  if (mark !== undefined)
    await trees.saveIfAbsentInTree(tree, WITHOUT_RECOVERY_KEY, {
      callsModel: mark.callsModel,
    });
}
