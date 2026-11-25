import { isExecutionCancelled } from "../core/execution-cancelled.js";
import { interruptErrorOf, interruptOf, markedInterruptOf } from "./interrupt-requests.js";
import { nodeRecordIn } from "../flow/runtime/workflow-keys.js";
import { maskedRecordOf, runResultOf } from "./result.js";
import { maskedPendingOf } from "./record-masks.js";
import { executionEventAt, observeLeg } from "./run-events.js";
import { leasedDeps, treeOf } from "./tree-ends.js";
import type { HeldPass, TreeCall, TreeMoveParts, TreePass, TreeState } from "./tree-move-types.js";
import { unwindingDeps } from "./tree-unwind.js";
import type { ExecutionOutput } from "./types.js";
import { cancelledOutputOf } from "./cancelled-output.js";
import { isPause } from "./lease-stopped.js";
import { parkedOutputOf } from "./parked-output.js";
import { storedOutputOf } from "../pii/final-output-mask.js";

/**
 * One pass of a tree (`tree-moves.ts`), observed and settled while its lease is held; a cancel
 * request aborts it, and the pass then returns the cancelled output (#1341). A pass that fails undoes the tree's open undoable actions before the root's
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
  const interrupted = interruptedOf(parts, state);
  const at = { signal, lease: held.lease, undo, interrupted };
  const moving = unwindingDeps(leasedDeps(deps, held.lease), state, at);
  const leg = async (): Promise<ExecutionOutput> => {
    try {
      const run = await live.track(state, AbortSignal.any(caller), (signal) =>
        pass(moving, signal),
      );
      await paused.settle(run);
      const result = runResultOf(run, call.includeRecord === true, (name) =>
        nodeRecordIn(deps, name),
      );
      return await maskedRecordOf(result, deps);
    } catch (error) {
      if (!isExecutionCancelled(error)) throw error;
      // an operator's pause parks the tree (#1341c): nothing undone, no record ended — the pass
      // returns the paused output and the drain writes the rest (`passesOf`)
      if (isPause(error)) return parkedOutputOf(deps, state, error);
      // a cancel is an outcome, not a failure (#1341): its undo ran before this error, and the
      // call resolves cancelled — an undo that failed is `ExecutionError.CompensationFailed`, thrown on
      return cancelledOutputOf(deps, state, { cause: error, compensations: undo.compensations });
    }
  };
  return observeLeg(
    deps.observer,
    executionEventAt(state, deps),
    () => heldAtTheEnd(held, leg),
    () => undo.compensations ?? [],
    // a child's pause in the root's event: masked by the child's chain too (#1150)
    (pending) => maskedPendingOf(deps, pending),
    // the end event, and the A2A task written from it, hold the finish DTO's sensitive fields masked (#1301)
    (result) => maskedResultOutputOf(deps, result),
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

/** The cancel or stop the tree's lease row marks, as the error its execution ends with (#1341b). */
const interruptedOf =
  (parts: Pick<TreeMoveParts, "leases" | "trees">, state: TreeState) =>
  async (): Promise<Error | undefined> => {
    const tree = treeOf(state);
    // the key has the reason; the lease row's mark is the fallback of a request that died half way
    const request =
      (await interruptOf(parts.trees, tree, parts.leases)) ??
      (await markedInterruptOf(parts.leases, tree));
    return request === undefined ? undefined : interruptErrorOf(request, state.threadId);
  };

/** A finished result's output with its finish DTO's sensitive fields masked; the result's own stays. */
const maskedResultOutputOf = (deps: TreeMoveParts["deps"], result: ExecutionOutput): unknown =>
  result.finish === undefined
    ? result.output
    : storedOutputOf(deps, result.finish.name, result.output);
