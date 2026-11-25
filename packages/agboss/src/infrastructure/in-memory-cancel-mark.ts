import { InterruptMode } from "../app/interrupt-types.js";
import { waitOf } from "./clock.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { memoryStatusLog, type NewStatusTransition } from "../turns/index.js";
import { treeKeyOf, type ExecutionLeaseRow, type InMemoryDatabase } from "./in-memory-database.js";

/**
 * A tree's cancel mark in memory (#909, #1117): `cancelRequestedAt` on the tree's own lease row,
 * set once and kept by every later write of the row — no lease operation and no retention lifts it.
 */

/**
 * The tree's marks of a stored row, for the row written in its place: kept for good. A reclaim
 * passes its new token as `reclaimedAt` (#1341c): while an `Immediate` pause is set the fence rises
 * to it (`GREATEST`) in the same synchronous step, so the holder gets no token above the fence.
 */
export const markOf = (
  stored: ExecutionLeaseRow | undefined,
  reclaimedAt?: number,
): Pick<
  ExecutionLeaseRow,
  "cancelRequestedAt" | "stopMode" | "externalPause" | "fencedThroughToken"
> => ({
  ...(stored?.cancelRequestedAt === undefined
    ? {}
    : { cancelRequestedAt: stored.cancelRequestedAt }),
  ...(stored?.stopMode === undefined ? {} : { stopMode: stored.stopMode }),
  ...(stored?.externalPause === undefined ? {} : { externalPause: stored.externalPause }),
  ...fenceOf(stored, reclaimedAt),
});

/** The row's fence, raised to `reclaimedAt` while an `Immediate` pause is set (see `markOf`). */
function fenceOf(
  stored: ExecutionLeaseRow | undefined,
  reclaimedAt: number | undefined,
): Pick<ExecutionLeaseRow, "fencedThroughToken"> {
  const kept = stored?.fencedThroughToken;
  const isRaised =
    reclaimedAt !== undefined && stored?.externalPause?.mode === InterruptMode.Immediate;
  const fenced = isRaised ? Math.max(kept ?? 0, reclaimedAt) : kept;
  return fenced === undefined ? {} : { fencedThroughToken: fenced };
}

/**
 * The row of a tree cancelled before its first acquire: token 0, released, never held — its first
 * acquire is token 1 and no takeover, as of a key with no row.
 */
export const seedRowOf = (tree: ExecutionTree): ExecutionLeaseRow => ({
  lease: {
    tenantId: tree.tenantId,
    rootExecutionId: tree.rootExecutionId,
    holderInstanceId: "",
    token: 0,
    expiresAt: new Date(0),
    remaining: waitOf(0),
  },
  released: true,
});

/** Marks the tree's cancel at `now` (ms) on its lease row — a seed row when it has none: once. */
export function markedInMemoryCancel(
  database: InMemoryDatabase,
  tree: ExecutionTree,
  now: number,
  transition?: NewStatusTransition,
): Promise<void> {
  const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
  const stored = database.executionLeases.get(key) ?? seedRowOf(tree);
  if (stored.cancelRequestedAt === undefined) {
    database.executionLeases.set(key, { ...stored, cancelRequestedAt: now });
    // the mark and its history row land in one synchronous step (#1341d)
    if (transition !== undefined)
      memoryStatusLog(database.statusTransitions).appended(transition, new Date(now));
  }
  return Promise.resolve();
}

/** Whether the tree's lease row, a seed row too, carries its cancel mark (#1152). */
export const isInMemoryCancelMarked = (database: InMemoryDatabase, tree: ExecutionTree): boolean =>
  database.executionLeases.get(treeKeyOf(tree.tenantId, tree.rootExecutionId))
    ?.cancelRequestedAt !== undefined;

/**
 * Marks the tree's stop on its lease row (#1341b) — a seed row when it has none: the mode only
 * escalates (`AfterStep` to `Immediate`), a repeat changes nothing. The history row, when given, is
 * written in the same synchronous step, and only when this call set or escalated the mark.
 */
export function markedInMemoryStop(
  database: InMemoryDatabase,
  tree: ExecutionTree,
  stop: {
    readonly mode: InterruptMode;
    readonly now: number;
    readonly transition?: NewStatusTransition;
  },
): Promise<void> {
  const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
  const stored = database.executionLeases.get(key) ?? seedRowOf(tree);
  const isNew = stored.stopMode === undefined;
  const isEscalated =
    stored.stopMode === InterruptMode.AfterStep && stop.mode === InterruptMode.Immediate;
  if (!isNew && !isEscalated) return Promise.resolve();
  database.executionLeases.set(key, { ...stored, stopMode: stop.mode });
  if (stop.transition !== undefined)
    memoryStatusLog(database.statusTransitions).appended(stop.transition, new Date(stop.now));
  return Promise.resolve();
}

/** The mode of the tree's stop mark, `undefined` for a tree never stopped. */
export const inMemoryStopOf = (
  database: InMemoryDatabase,
  tree: ExecutionTree,
): { readonly mode: InterruptMode } | undefined => {
  const mode = database.executionLeases.get(
    treeKeyOf(tree.tenantId, tree.rootExecutionId),
  )?.stopMode;
  return mode === undefined ? undefined : { mode };
};

/**
 * Whether a tree carries a stop or a cancel mark on its in-memory lease row (#1341b): what the
 * in-memory records read in the finish's own synchronous step, so a mark never lands in between.
 */
export const inMemoryInterruptedOf =
  (database: InMemoryDatabase) =>
  (tree: ExecutionTree): boolean =>
    isInMemoryCancelMarked(database, tree) || inMemoryStopOf(database, tree) !== undefined;
