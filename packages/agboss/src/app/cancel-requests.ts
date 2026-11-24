import type {
  ExecutionTree,
  ExecutionTreeRepository,
} from "../infrastructure/execution-tree.repository.js";
import type { ExecutionLeases, HeldExecutionLease, RenewalCheck } from "./execution-leases.js";
import { requestChecksOf } from "./request-checks.js";
import type { ThreadKey } from "./live-runs.js";
import { cancelTransitionOf, isMarkedAlive } from "./cancel-marks.js";
import { endedWithoutPass } from "./ended-tree.js";
import { cancelledErrorOf } from "./live-runs.js";
import {
  CANCEL_REQUEST_KEY,
  interruptCauseOf,
  stopModeOf,
  InterruptKind,
  interruptErrorOf,
  interruptOf,
  isStop,
  requestValueOf,
  type RequestValue,
} from "./interrupt-requests.js";
import { InterruptMode } from "./interrupt-types.js";
import { writeStopRequest } from "./stop-requests.js";
import { ExecutionPausedError } from "./lease-stopped.js";
import { treeOf, WITHOUT_RECOVERY_KEY } from "./tree-ends.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { rootTakeOf } from "./execution-leases.js";
import { recordEndedOf } from "./recovery-pass.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import type { EndedTreeUndo } from "./tree-unwind.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";

/**
 * Cancelling from any instance (#360): `app.cancel` on an instance that does not move the thread's
 * execution writes a cancel request under the reserved tree key `@agboss/cancel-request` of the
 * shared `ExecutionTreeRepository`; the holder reads it after every confirmed lease renewal (the
 * background one every 10 s and the one before each checkpoint write) and before its tree rests
 * paused, and an instance taking the tree's lease (a resume, a recovery) reads it first — a found
 * request stops the execution as a local cancel does, or ends the tree as cancelled without a pass.
 * The key goes with the tree's other keys when it ends. Loaded on the first cancel or tree pass.
 */

export { CANCEL_REQUEST_KEY };

/** What ending a cancelled tree needs from its workflow's app. */
export type CancelParts = Pick<TreeMoveParts, "deps" | "paused" | "trees" | "clock" | "leases">;

/**
 * Whether the tree has a cancel or a stop request (#1341b: both end it early); a store error reads
 * as none (asked again later).
 */
export async function isCancelRequested(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
): Promise<boolean> {
  return (await interruptOf(trees, tree)) !== undefined;
}

/**
 * Whether a lease taken over ends the tree without a pass: a cancel request, or a run no recovery
 * continues (#860); a store error reads as neither (asked again later).
 */
export async function isEndedAtTakeover(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
): Promise<boolean> {
  if (await isCancelRequested(trees, tree)) return true;
  try {
    return (await trees.findByIdInTree(tree, WITHOUT_RECOVERY_KEY)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Writes a tree's cancel request, the one place every cancel path does (#1073): the lease store's
 * mark first (#909, the fence on every instance), then the tree key everything that decides
 * whether the tree goes on reads — the holder's watch, a lease taken over, the expiry look's two
 * checks. A cancel that wrote only the mark would not be seen by them.
 */
export async function writeCancelRequest(
  parts: Pick<CancelParts, "leases" | "trees">,
  tree: ExecutionTree,
  request: RequestValue & {
    /** The thread the cancel is of: its history row is written with the mark (#1341d). */
    readonly threadId?: string;
    /** `Stop` writes a stop request instead (#1341b) — with the mode of `request.mode`. */
    readonly kind?: InterruptKind;
  },
): Promise<void> {
  if (request.kind === InterruptKind.Stop)
    return writeStopRequest(parts, tree, {
      ...request,
      mode: request.mode ?? InterruptMode.AfterStep,
    });
  const { threadId } = request;
  const transition =
    threadId === undefined ? undefined : cancelTransitionOf({ ...tree, threadId }, request);
  await parts.leases.requestCancel(tree, transition);
  await parts.trees.saveIfAbsentInTree(tree, CANCEL_REQUEST_KEY, requestValueOf(request));
}

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
  // an operator's pause, from the lease row — the database is the authority (D6): `Immediate` is the
  // fence on the holder's own token, `AfterStep` lets the step in flight finish and starts none
  const pauseFound = async (): Promise<void> => {
    const marks = await leases?.pauseOf(treeOf(state)).catch(() => undefined);
    if (marks?.pause === undefined) return;
    const { reason } = marks.pause;
    const error = new ExecutionPausedError({
      message: `thread "${state.threadId}" was paused`,
      ...(reason === undefined ? {} : { details: { reason } }),
    });
    const token = held?.token;
    const isImmediate =
      token !== undefined && marks.fencedThroughToken !== undefined && marks.fencedThroughToken >= token;
    if (isImmediate) controller.abort(error);
    else held?.stopAfterStep(error);
  };
  return {
    signal: controller.signal,
    isRequested,
    attach: (lease) => {
      held = lease;
    },
    abortNow: (cause) => {
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

/**
 * Ends a tree whose cancel was requested, under its lease and without a pass (`ended-tree.ts`): its
 * open undoable actions undone (#340 PR 3, under `signal`), its record ended as cancelled after
 * the undo (S7 3); the tree's cancelled output — or `CompensationFailedError` when an undo failed
 * (S7 1), which the moving call rejects with.
 */
export async function endCancelled(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
  undo?: EndedTreeUndo,
): Promise<ExecutionOutput | Error> {
  const cause = await interruptCauseOf(parts, treeOf(state), state.threadId);
  const end = { cause, signal: lease.signal, lease, ...(undo === undefined ? {} : { undo }) };
  const ended = await endedWithoutPass(parts, state, end);
  // a cancelled tree resolves its caller cancelled; an undo that failed rejects with its error
  return ended.output ?? ended.error;
}

/** A lease just taken (a resume, a recovery): a tree with a request is ended, the lease released. */
export async function endedAtTake(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<ExecutionOutput | Error | undefined> {
  const tree = treeOf(state);
  if (!(await isEndedAtTakeover(parts.trees, tree)) && !(await isMarkedAlive(parts, state)))
    return undefined;
  try {
    return await endCancelled(parts, state, lease);
  } finally {
    await lease.release();
  }
}

/**
 * A tree about to rest paused with a request: ended as cancelled, and the moving call resolves with
 * the cancelled output (rejects with `CompensationFailedError` when an undo failed); `undefined`
 * when there is no request.
 */
export async function endIfCancelledAtRest(
  parts: CancelParts,
  state: TreeState,
  rest: {
    readonly result: ExecutionOutput;
    readonly watch: CancelWatch;
    readonly lease: HeldExecutionLease;
    /** What its undo runs, for the record its pass keeps after (#635). */
    readonly undo: EndedTreeUndo;
  },
): Promise<ExecutionOutput | undefined> {
  const { result, watch, lease, undo } = rest;
  if (result.status !== ExecutionStatus.Paused || !(await watch.isRequested())) return undefined;
  const ended = await endCancelled(parts, state, lease, undo);
  if (ended instanceof Error) throw ended;
  return ended;
}

/** A root the recovery sweep found `running`: its record (#520: ended → no takeover). */
export interface SweptRoot {
  readonly turnId: string;
}

/**
 * Ends a tree as cancelled once its lease is held here (waiting for a holder that rests it): its
 * cancelled output (or the final error of an undo that failed), or `undefined` when its lease was
 * not free.
 */
export async function endHeld(
  parts: CancelParts,
  state: TreeState,
  sweep?: SweptRoot,
): Promise<ExecutionOutput | Error | undefined> {
  const tree = treeOf(state);
  const isWaiting = sweep === undefined;
  // the sweep's take (not waiting) is a takeover of a root another pass was moving (#501), none
  // once its record ended (#520)
  const take = {
    ...rootTakeOf(parts.deps.pause, state.runId, LeaseTakeoverReason.Cancelled, !isWaiting),
    ...(sweep === undefined ? {} : { isOver: recordEndedOf(parts.deps.turns, sweep.turnId) }),
  };
  const lease = isWaiting
    ? await parts.leases.hold(tree, undefined, take)
    : await parts.leases.tryHold(tree, take);
  if (lease === undefined) return undefined;
  try {
    return await endCancelled(parts, state, lease);
  } finally {
    await lease.release();
  }
}

/**
 * Recovery of a root with a cancel request (S1 3: on an instance of any config version): it is
 * ended as cancelled when its lease is free; `true` when it had a request (a holder ends it).
 */
export async function endIfCancelled(
  parts: CancelParts,
  state: TreeState & SweptRoot,
): Promise<boolean> {
  const tree = treeOf(state);
  if (!(await isEndedAtTakeover(parts.trees, tree)) && !(await isMarkedAlive(parts, state)))
    return false;
  await endHeld(parts, state, state);
  return true;
}
