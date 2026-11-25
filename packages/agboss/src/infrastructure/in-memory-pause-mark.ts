import { InterruptMode as Mode } from "../app/interrupt-types.js";
import { memoryStatusLog, type NewStatusTransition } from "../turns/index.js";
import type { PauseMarks, PauseRequest } from "./execution-lease-contract.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { seedRowOf } from "./in-memory-cancel-mark.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

/**
 * A tree's external pause on its in-memory lease row (#1341c): `externalPause` while an operator's
 * `app.pause` holds it, and `fencedThroughToken`, which only ever rises (`GREATEST`) and which
 * `unpause` never lowers. A tree with no row gets a seed row (token 0, released, never held).
 */

/** Marks the tree paused from outside; an `Immediate` pause fences the row's current token and below. */
export function pausedInMemory(
  database: InMemoryDatabase,
  tree: ExecutionTree,
  pause: {
    readonly request: PauseRequest;
    readonly now: number;
    readonly transition?: NewStatusTransition;
  },
): Promise<void> {
  const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
  const stored = database.executionLeases.get(key) ?? seedRowOf(tree);
  const { request } = pause;
  const wasPaused = stored.externalPause !== undefined;
  const through =
    request.mode === Mode.Immediate
      ? Math.max(stored.fencedThroughToken ?? 0, stored.lease.token)
      : stored.fencedThroughToken;
  database.executionLeases.set(key, {
    ...stored,
    externalPause: {
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      // the mode only escalates: a repeat that asks `AfterStep` of an `Immediate` pause changes nothing
      mode: stored.externalPause?.mode === Mode.Immediate ? Mode.Immediate : request.mode,
    },
    ...(through === undefined ? {} : { fencedThroughToken: through }),
  });
  // the mark and its history row land in one synchronous step; a repeat writes none
  if (!wasPaused && pause.transition !== undefined)
    memoryStatusLog(database.statusTransitions).appended(pause.transition, new Date(pause.now));
  return Promise.resolve();
}

/** Lifts the pause; the fence stays. */
export function unpausedInMemory(
  database: InMemoryDatabase,
  tree: ExecutionTree,
  lift: { readonly now: number; readonly transition?: NewStatusTransition },
): Promise<void> {
  const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
  const stored = database.executionLeases.get(key);
  if (stored?.externalPause === undefined) return Promise.resolve();
  const lifted = { ...stored };
  Reflect.deleteProperty(lifted, "externalPause");
  database.executionLeases.set(key, lifted);
  if (lift.transition !== undefined)
    memoryStatusLog(database.statusTransitions).appended(lift.transition, new Date(lift.now));
  return Promise.resolve();
}

/** The tree's external pause and its fence. */
export function inMemoryPauseOf(database: InMemoryDatabase, tree: ExecutionTree): PauseMarks {
  const row = database.executionLeases.get(treeKeyOf(tree.tenantId, tree.rootExecutionId));
  return {
    ...(row?.externalPause === undefined ? {} : { pause: row.externalPause }),
    ...(row?.fencedThroughToken === undefined
      ? {}
      : { fencedThroughToken: row.fencedThroughToken }),
  };
}
