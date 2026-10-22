import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import { maskedRecordOf, runResultOf } from "./result.js";
import { executionEventAt, observeLeg } from "./run-events.js";
import { leasedDeps } from "./tree-ends.js";
import type { HeldPass, TreeCall, TreeMoveParts, TreePass, TreeState } from "./tree-move-types.js";
import { undoingPass, type EndedTreeUndo } from "./tree-unwind.js";
import type { ExecutionOutput } from "./types.js";

/**
 * One pass of a tree (`tree-moves.ts`), observed and settled while its lease is held; a cancel
 * request aborts it. A pass that rejects undoes the tree's open undoable actions before its error
 * is observed (#340 PR 3) — `ExecutionErrorEvent.compensations` lists what ran.
 */
export function observedPass(
  parts: TreeMoveParts,
  state: TreeState,
  call: TreeCall,
  held: HeldPass,
  pass: TreePass,
): Promise<ExecutionOutput> {
  const { deps, live, paused } = parts;
  const stops = [held.lease.signal, held.watch.signal];
  const caller = call.signal === undefined ? stops : [call.signal, ...stops];
  const moving = leasedDeps(deps, held.lease);
  const undo: EndedTreeUndo = { compensations: [] };
  const at = { signal: held.lease.signal, undo };
  const leg = async (): Promise<ExecutionOutput> => {
    const run = await undoingPass(deps, state, at, () =>
      live.track(state, AbortSignal.any(caller), (signal) => pass(moving, signal)),
    );
    await paused.settle(run);
    const result = runResultOf(run, call.record === true, (name) => nodeRecordIn(deps, name));
    return maskedRecordOf(result, deps.pii?.observability);
  };
  return observeLeg(deps.observer, executionEventAt(state, deps), leg, () => undo.compensations);
}
