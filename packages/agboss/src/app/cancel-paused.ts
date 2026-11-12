import { ExecutionCancelledError } from "../core/errors.js";
import { CompensationFailedError } from "../flow/compensation.js";
import type { CancelParts } from "./cancel-requests.js";
import { endedWithoutPass } from "./ended-tree.js";
import type { ThreadKey } from "./live-runs.js";
import { treeOf } from "./tree-ends.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { rootTakeOf } from "./execution-leases.js";

/**
 * `app.cancel` of a thread whose tree rests paused on this application (#340 PR 3, Q6): under the
 * tree's lease its paused run is dropped — its pauses withdrawn first (#337) — then its open
 * undoable actions are undone (each bounded by `compensationTimeout`) while its record is `running`
 * (S7 3), then its record is failed as cancelled, its keys removed and `onExecutionError` observed.
 * The cancel returns after the undo; `false` when the thread rests paused no more. An undo that
 * failed — the others ran — rejects the cancel with `CompensationFailedError`, its cause the
 * `ExecutionCancelledError` (S7 1). With `runId`, only that execution's paused run (#807).
 */
export async function cancelledPaused(
  parts: CancelParts,
  thread: ThreadKey,
  runId?: string,
): Promise<boolean> {
  const { deps, paused, leases } = parts;
  const found = await paused.find(thread);
  if (found === undefined) return false;
  // a cancel of one execution (#807) holds that tree's lease and ends that run only — never
  // another run of its thread, paused before the look or since
  const tree = { ...thread, runId: runId ?? found.run.runId };
  const startedVersion = found.run.startedVersion ?? deps.config.version;
  // the mark first (#909): from here on no effect of the tree but its undo's is accepted
  await leases.requestCancel({ tenantId: thread.tenantId, rootExecutionId: tree.runId });
  const take = rootTakeOf(deps.pause, tree.runId, LeaseTakeoverReason.Cancelled);
  const lease = await leases.hold(treeOf({ ...tree, startedVersion }), undefined, take);
  try {
    // a holder moved it meanwhile — not paused any more, or another run of the thread paused
    // since: the caller asks its holder instead
    const run = await paused.drop(thread, tree.runId);
    if (run === undefined) return false;
    const state = { ...tree, startedVersion: run.startedVersion ?? deps.config.version };
    const cause = new ExecutionCancelledError({
      message: `thread "${thread.threadId}" was cancelled while paused`,
    });
    const ended = await endedWithoutPass(parts, state, { cause, signal: lease.signal, lease });
    if (ended.error instanceof CompensationFailedError) throw ended.error;
    return true;
  } finally {
    await lease.release();
  }
}
