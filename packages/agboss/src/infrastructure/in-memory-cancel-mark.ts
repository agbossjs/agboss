import { waitOf } from "./clock.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { memoryStatusLog, type NewStatusTransition } from "../turns/index.js";
import { treeKeyOf, type ExecutionLeaseRow, type InMemoryDatabase } from "./in-memory-database.js";

/**
 * A tree's cancel mark in memory (#909, #1117): `cancelRequestedAt` on the tree's own lease row,
 * set once and kept by every later write of the row — no lease operation and no retention lifts it.
 */

/** The tree's cancel mark of a stored row, for the row written in its place: kept for good. */
export const markOf = (
  stored: ExecutionLeaseRow | undefined,
): { readonly cancelRequestedAt?: number } =>
  stored?.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: stored.cancelRequestedAt };

/**
 * The row of a tree cancelled before its first acquire: token 0, released, never held — its first
 * acquire is token 1 and no takeover, as of a key with no row.
 */
const seedRowOf = (tree: ExecutionTree): ExecutionLeaseRow => ({
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
