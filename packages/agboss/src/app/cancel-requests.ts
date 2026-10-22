import type {
  ExecutionTree,
  ExecutionTreeRepository,
} from "../infrastructure/execution-tree.repository.js";
import type { Tern } from "../terns/index.js";
import type { AppDeps } from "./app-deps.js";
import type { HeldExecutionLease, RenewalCheck } from "./execution-leases.js";
import { CompensationFailedError } from "../flow/compensation.js";
import { endedWithoutPass } from "./ended-tree.js";
import { cancelledErrorOf, type ThreadKey } from "./live-runs.js";
import { treeOf } from "./tree-ends.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
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

/** The reserved key of a cancel request: `@agboss/` tree keys belong to the framework. */
export const CANCEL_REQUEST_KEY = "@agboss/cancel-request";

/** How many of a thread's last records are looked at for its root's record. */
const RECORDS = 20;

/** What ending a cancelled tree needs from its workflow's app. */
export type CancelParts = Pick<TreeMoveParts, "deps" | "paused" | "trees" | "clock" | "leases">;

/** Whether the tree has a cancel request; a store error reads as none (asked again later). */
export async function isCancelRequested(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
): Promise<boolean> {
  try {
    return (await trees.findByIdInTree(tree, CANCEL_REQUEST_KEY)) !== undefined;
  } catch {
    return false;
  }
}

/** The holder's watch over one tree's cancel request (#360). */
export interface CancelWatch {
  /** Aborted with the thread's `ExecutionCancelledError` once a check finds the request. */
  readonly signal: AbortSignal;
  /** Reads the request and aborts `signal` when it is there; never throws (a lease's renewal check). */
  readonly check: RenewalCheck;
  /** Whether the request is there now. */
  readonly isRequested: () => Promise<boolean>;
}

export function cancelWatchOf(trees: ExecutionTreeRepository, state: TreeState): CancelWatch {
  const controller = new AbortController();
  const isRequested = (): Promise<boolean> => isCancelRequested(trees, treeOf(state));
  return {
    signal: controller.signal,
    isRequested,
    check: async () => {
      if (controller.signal.aborted || !(await isRequested())) return;
      controller.abort(cancelledErrorOf(state.threadId));
    },
  };
}

/**
 * Ends a tree whose cancel was requested, under its lease and without a pass (`ended-tree.ts`): its
 * open undoable actions undone (#340 PR 3, under `signal`), its record failed as cancelled after
 * the undo (S7 3); the tree's final error — `CompensationFailedError` when an undo failed (S7 1).
 */
export async function endCancelled(
  parts: CancelParts,
  state: TreeState,
  signal: AbortSignal,
): Promise<Error> {
  const cause = cancelledErrorOf(state.threadId);
  return (await endedWithoutPass(parts, state, { cause, signal })).error;
}

/** A lease just taken (a resume, a recovery): a tree with a request is ended, the lease released. */
export async function endedAtTake(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<Error | undefined> {
  if (!(await isCancelRequested(parts.trees, treeOf(state)))) return undefined;
  try {
    return await endCancelled(parts, state, lease.signal);
  } finally {
    await lease.release();
  }
}

/** A tree about to rest paused with a request: ended as cancelled, and the moving call rejects. */
export async function endIfCancelledAtRest(
  parts: CancelParts,
  state: TreeState,
  rest: {
    readonly result: ExecutionOutput;
    readonly watch: CancelWatch;
    readonly lease: HeldExecutionLease;
  },
): Promise<void> {
  const { result, watch, lease } = rest;
  if (result.status !== ExecutionStatus.Paused || !(await watch.isRequested())) return;
  throw await endCancelled(parts, state, lease.signal);
}

/**
 * Ends a tree as cancelled once its lease is held here (waiting for a holder that rests it): its
 * final error, or `undefined` when its lease was not free.
 */
async function endHeld(
  parts: CancelParts,
  state: TreeState,
  isWaiting: boolean,
): Promise<Error | undefined> {
  const tree = treeOf(state);
  const lease = isWaiting ? await parts.leases.hold(tree) : await parts.leases.tryHold(tree);
  if (lease === undefined) return undefined;
  try {
    return await endCancelled(parts, state, lease.signal);
  } finally {
    await lease.release();
  }
}

/**
 * Recovery of a root with a cancel request (S1 3: on an instance of any config version): it is
 * ended as cancelled when its lease is free; `true` when it had a request (a holder ends it).
 */
export async function endIfCancelled(parts: CancelParts, state: TreeState): Promise<boolean> {
  if (!(await isCancelRequested(parts.trees, treeOf(state)))) return false;
  await endHeld(parts, state, false);
  return true;
}

/** A record's tree as its events name it. */
const stateOf = (deps: AppDeps, record: Tern, runId: string): TreeState => ({
  runId,
  threadId: record.threadId,
  tenantId: record.tenantId,
  startedVersion: record.configVersion ?? deps.config.version,
});

/**
 * What became of a requested tree after the request: `true` when it counts as cancelled; one this
 * call ended whose undo failed rejects with `CompensationFailedError` (#340 S7 1).
 */
async function settled(parts: CancelParts, record: Tern): Promise<boolean> {
  if (record.runId === null) return false;
  const state = stateOf(parts.deps, record, record.runId);
  if (record.status === "running") return true;
  if (record.status === "paused") {
    const ended = await endHeld(parts, state, true);
    if (ended instanceof CompensationFailedError) throw ended;
    return ended !== undefined;
  }
  // it ended between the request and now: the request is withdrawn with the tree's keys
  await parts.trees.deleteAllInTree(treeOf(state));
  return false;
}

/**
 * A cancel of a thread whose execution runs on another instance (#360): every `running` root of
 * the thread gets a request, then is read again — still running: cancelled (its holder stops
 * within one renewal, or recovery ends it); paused meanwhile: ended here; ended: not cancelled. A
 * root whose `running` record is not written yet (its budgets, its thread's compaction) is not
 * found: `false` (S1 5).
 */
export async function remoteCancel(
  parts: CancelParts,
  thread: ThreadKey,
  ownerId: string | undefined,
): Promise<boolean> {
  const { deps, trees, clock } = parts;
  const records = await deps.terns.lastTerns(thread.tenantId, thread.threadId, RECORDS);
  const running = records.filter(
    (record) => record.status === "running" && record.bundle === deps.config.name,
  );
  const request = { requestedAt: clock.now().toISOString(), ownerId: ownerId ?? null };
  for (const record of running) {
    if (record.runId === null) continue;
    const tree = { tenantId: thread.tenantId, rootExecutionId: record.runId };
    await trees.saveIfAbsentInTree(tree, CANCEL_REQUEST_KEY, request);
  }
  let isCancelled = false;
  const now = running.length === 0 ? [] : await deps.terns.byIds(running.map(({ id }) => id));
  for (const record of now) isCancelled = (await settled(parts, record)) || isCancelled;
  return isCancelled;
}
