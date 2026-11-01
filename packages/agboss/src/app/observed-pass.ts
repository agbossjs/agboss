import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import { maskedRecordOf, runResultOf } from "./result.js";
import { executionEventAt, observeLeg } from "./run-events.js";
import { leasedDeps } from "./tree-ends.js";
import type { HeldPass, TreeCall, TreeMoveParts, TreePass, TreeState } from "./tree-move-types.js";
import { unwindingDeps } from "./tree-unwind.js";
import type { ExecutionOutput } from "./types.js";

/**
 * One pass of a tree (`tree-moves.ts`), observed and settled while its lease is held; a cancel
 * request aborts it. A pass that fails undoes the tree's open undoable actions before the root's
 * record is failed and its error observed (#340 PR 3, S7 3) — `ExecutionErrorEvent.compensations`
 * lists what ran; the undo stops only on a lost lease or the app's stop, never on a cancel.
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
  const { undo } = held;
  const signal = AbortSignal.any([held.lease.signal, live.interruption]);
  const at = { signal, lease: held.lease, undo };
  const moving = unwindingDeps(leasedDeps(deps, held.lease), state, at);
  const leg = async (): Promise<ExecutionOutput> => {
    const run = await live.track(state, AbortSignal.any(caller), (signal) => pass(moving, signal));
    await paused.settle(run);
    const result = runResultOf(run, call.record === true, (name) => nodeRecordIn(deps, name));
    return maskedRecordOf(result, deps.pii?.observability);
  };
  return observeLeg(
    deps.observer,
    executionEventAt(state, deps),
    () => heldAtTheEnd(held, leg),
    () => undo.compensations ?? [],
  );
}

/**
 * The leg's outcome, announced only while this pass still holds the tree (#597): a holder that
 * froze after the tree's end became durable — its lease taken over, the end announced by the
 * instance that recovered it — stops at its own fence (`assertHeld`, #533) with
 * `ExecutionLeaseLostError`, a hand-over: no `onExecutionEnd` / `onExecutionError` from it, its
 * call rejects. At most once: a holder frozen between this look and its observer call is the window.
 */
async function heldAtTheEnd(
  held: HeldPass,
  leg: () => Promise<ExecutionOutput>,
): Promise<ExecutionOutput> {
  let result: ExecutionOutput;
  try {
    result = await leg();
  } catch (error) {
    held.lease.assertHeld();
    throw error;
  }
  held.lease.assertHeld();
  return result;
}
