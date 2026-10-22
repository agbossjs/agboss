import { ExecutionCancelledError } from "../core/errors.js";
import type { CancelParts } from "./cancel-requests.js";
import { cancelledOutcome, type ThreadKey } from "./live-runs.js";
import { executionEventAt } from "./run-events.js";
import { treeOf } from "./tree-ends.js";
import { undoneTreeEnd, type EndedTreeUndo } from "./tree-unwind.js";

/**
 * `app.cancel` of a thread whose tree rests paused on this application (#340 PR 3, Q6): under the
 * tree's lease its paused run is dropped — its pauses withdrawn first (#337) — then its open
 * undoable actions are undone (each bounded by `compensationTimeout`), its keys removed, its record
 * failed as cancelled and `onExecutionError` observed (`CompensationFailedError` when an undo
 * failed). The cancel returns after the undo; `false` when the thread rests paused no more.
 */
export async function cancelledPaused(parts: CancelParts, thread: ThreadKey): Promise<boolean> {
  const { deps, paused, leases, trees } = parts;
  const found = await paused.find(thread);
  if (found === undefined) return false;
  const { run } = found;
  const startedVersion = run.startedVersion ?? deps.config.version;
  const state = { ...thread, runId: run.runId, startedVersion };
  const lease = await leases.hold(treeOf(state));
  try {
    // a holder moved it meanwhile: not paused any more — the caller asks its holder instead
    const waiting = await paused.drop(thread);
    if (waiting === undefined) return false;
    const cause = new ExecutionCancelledError(
      `thread "${thread.threadId}" was cancelled while paused`,
    );
    const undo: EndedTreeUndo = { compensations: [] };
    const ended = await undoneTreeEnd(deps, state, { error: cause, signal: lease.signal }, undo);
    await trees.deleteAllInTree(treeOf(state));
    await deps.terns.complete(waiting.ternId, cancelledOutcome(waiting));
    const error = ended instanceof Error ? ended : cause;
    const event = executionEventAt(state, deps);
    await deps.observer.onExecutionError({ ...event, error, compensations: undo.compensations });
    return true;
  } finally {
    await lease.release();
  }
}
