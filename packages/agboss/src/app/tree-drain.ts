import { lazyLoad } from "../infrastructure/clock.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { passesOf, type DrainSteps } from "./drain-passes.js";
import { keepExecutionRecord, historyEndOf, historyRestOf } from "./execution-history.js";
import { cancelCauseOf } from "./cancelled-output.js";
import { isHandedOver } from "./handed-over.js";
import { leaseScope } from "./lease-scope.js";
import { forgetTree, passEnded } from "./tree-ends.js";
import { withPauseAnswers } from "./result.js";
import type { PlannedPass, TreeCall, TreeMoveParts, TreeState } from "./tree-move-types.js";
import type { EndedTreeUndo } from "./tree-unwind.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";

/**
 * Passes until the tree finishes or rests paused with no recorded answer left (the drain, Q58);
 * the pauses each pass took are marked `Taken` once it returned; the lease released at the end —
 * while the instance stops, only after the tree's running step bodies returned (#367); the
 * record's pause answers read last.
 */
export async function drainTree(
  parts: TreeMoveParts,
  steps: DrainSteps,
  at: { readonly state: TreeState; readonly call: TreeCall },
  run: { readonly lease: HeldExecutionLease; readonly first: PlannedPass },
): Promise<ExecutionOutput> {
  const { deps, live } = parts;
  const { state, call } = at;
  const { lease, first } = run;
  // what the undo of the pass that ends the tree ran: its record lists it, as its event (#635)
  const undo: EndedTreeUndo = {};
  // the tree's terminal record (finished, failed, stopped or cancelled) is durable (#928)
  let isEnded = false;
  let leaveWatch: (() => void) | undefined;
  try {
    // a cancel requested on another instance stops the passes at a renewal (#360)
    const { cancelWatchOf, watchedBy } = await lazyLoad(import("./cancel-watch.js"));
    const watch = cancelWatchOf(parts.trees, state, parts.leases);
    leaveWatch = watchedBy(lease, watch, live, state);
    // the passes up to the terminal record's completion hold the lease (#928): an unanswered call
    // there hands over; the cleanup after them (kept record, keys) stays outside it
    const result = await leaseScope(lease, () =>
      passesOf(parts, steps, { state, call }, { held: { lease, watch, undo }, first }),
    );
    isEnded = result.status !== ExecutionStatus.Paused;
    // #699: the kept record first — a pod killed in the cleanup's round trips keeps it
    await keepExecutionRecord(deps, state, restOf(result, undo));
    if (isEnded) await forgetTree(parts, state, cancelCauseOf(result));
    // who answered each pause (#267 S107): read once the pauses were taken and withdrawn
    return await withPauseAnswers(result, deps);
  } catch (error) {
    if (!isHandedOver(error)) {
      await keepExecutionRecord(deps, state, historyEndOf(error, undo.compensations));
      await forgetTree(parts, state, error);
      isEnded = true;
    }
    throw error;
  } finally {
    leaveWatch?.();
    await passEnded(live, deps, state);
    await released(parts, { lease, state }, isEnded);
  }
}

/** How a returned tree stands in its kept record: a cancel keeps the error and the undo it ran. */
function restOf(result: ExecutionOutput, undo: EndedTreeUndo) {
  const cause = cancelCauseOf(result);
  return cause === undefined
    ? historyRestOf(result.status)
    : historyEndOf(cause, undo.compensations);
}

/**
 * The lease released. After the tree's terminal record is durable (#928) a release that fails or
 * hangs to its bound does not change what the caller gets — a client without an idempotency key
 * would retry a run that already charged: it is logged and the lease expires in its store.
 */
async function released(
  parts: TreeMoveParts,
  held: { readonly lease: HeldExecutionLease; readonly state: TreeState },
  isEnded: boolean,
): Promise<void> {
  const { lease, state } = held;
  if (!isEnded) return lease.release();
  await lease.release().catch((error: unknown) => {
    const text = `the lease of execution ${state.runId} was not released after its end (${String(error)}): it expires`;
    parts.deps.log.warn("execution.lease-release-failed", text, {
      executionId: state.runId,
      tenantId: state.tenantId,
    });
  });
}
