import type { ExecutionTreeRepository } from "../infrastructure/execution-tree.repository.js";
import { isCancelRequested } from "./cancel-requests.js";
import { cancelledErrorOf } from "./cancelled-run.js";
import type { ExecutionLeases, HeldExecutionLease, RenewalCheck } from "./execution-leases.js";
import {
  InterruptKind,
  interruptErrorOf,
  interruptOf,
  isStop,
  stopModeOf,
} from "./interrupt-requests.js";
import { InterruptMode } from "./interrupt-types.js";
import { isPause } from "./lease-stopped.js";
import type { ThreadKey } from "./live-runs.js";
import { pausedErrorOf, pausedTreeOf } from "./paused-tree.js";
import { requestChecksOf } from "./request-checks.js";
import { treeOf } from "./tree-ends.js";
import type { TreeState } from "./tree-move-types.js";

/** The holder's watch over one tree's cancel or stop request (#360, #1341b). */
export interface CancelWatch {
  /** Aborted with the request's error once a check finds an `Immediate` request. */
  readonly signal: AbortSignal;
  /** Reads the request and acts on it; never throws (a lease's renewal check). */
  readonly check: RenewalCheck;
  /** Whether a request is there now. */
  readonly isRequested: () => Promise<boolean>;
  /**
   * Aborts `signal` now, as `check` does after finding the request (#909): a fenced write was
   * refused by the tree's cancel or `Immediate` stop (`cause`) — no need to wait for the next
   * renewal. A no-op once aborted.
   */
  readonly abortNow: (cause?: Error) => void;
  /** The lease whose next step an `AfterStep` stop or pause refuses (`watchedBy`). */
  readonly attach: (lease: Pick<HeldExecutionLease, "stopAfterStep" | "token">) => void;
}

export function cancelWatchOf(
  trees: ExecutionTreeRepository,
  state: TreeState,
  leases?: Pick<ExecutionLeases, "isCancelRequested" | "stopOf" | "pauseOf">,
): CancelWatch {
  const controller = new AbortController();
  let held: Pick<HeldExecutionLease, "stopAfterStep" | "token"> | undefined;
  const isRequested = (): Promise<boolean> => isCancelRequested(trees, treeOf(state));
  // an operator's pause, from the lease row — the database is the authority (D6): `Immediate` aborts
  // the run, `AfterStep` lets the step in flight finish and starts none
  const pauseFound = async (): Promise<void> => {
    const paused = await pausedTreeOf(leases, treeOf(state), state.threadId);
    if (paused === undefined) return;
    if (paused.mode === InterruptMode.Immediate) controller.abort(paused.error);
    else held?.stopAfterStep(paused.error);
  };
  return {
    signal: controller.signal,
    isRequested,
    attach: (lease) => {
      held = lease;
    },
    abortNow: (cause) => {
      // a write refused by the tree's `Immediate` pause raced the holder's own notice (#1341c): the
      // holder parks, as it does when told; `parkedAtRest` finds out whether the pause still stands
      if (isPause(cause)) {
        controller.abort(pausedErrorOf(state.threadId));
        return;
      }
      const kind = isStop(cause) ? InterruptKind.Stop : InterruptKind.Cancel;
      controller.abort(
        kind === InterruptKind.Cancel
          ? cancelledErrorOf(state.threadId)
          : interruptErrorOf({ kind }, state.threadId),
      );
    },
    check: async () => {
      if (controller.signal.aborted) return;
      const request = await interruptOf(trees, treeOf(state), leases);
      // `Cancel > Stop > Pause` (#1341c): the operator's pause is looked for only when no cancel or stop is
      if (request === undefined) return pauseFound();
      const error = interruptErrorOf(request, state.threadId);
      // a stop's mode is the lease row's (it escalates there; the key keeps the first one)
      const mode = await stopModeOf(request, leases, treeOf(state));
      // `AfterStep`: the step in flight finishes, none starts after it; `Immediate` aborts the run
      if (mode === InterruptMode.AfterStep) held?.stopAfterStep(error);
      else controller.abort(error);
    },
  };
}

/**
 * Starts the holder's watch over its tree's cancel (#360, #909): the request is read after every
 * confirmed renewal, and a fenced write of a step refused by the tree's cancel aborts at once.
 */
export function watchedBy(
  lease: HeldExecutionLease,
  watch: CancelWatch,
  live?: object,
  thread?: ThreadKey,
): (() => void) | undefined {
  watch.attach(lease);
  lease.afterEachRenewal(watch.check);
  lease.whenCancelFound((cause) => {
    watch.abortNow(cause);
  });
  // a stop asked on this instance reaches the holder at once (#1341b)
  return live === undefined || thread === undefined
    ? undefined
    : requestChecksOf(live).watching(thread, watch.check);
}
