import type { CompensationRecord } from "../flow/compensation.js";
import type { AppDeps } from "./app-deps.js";
import { isHandedOver } from "./handed-over.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * The automatic undo of a tree whose execution ends without a finish (#340 PR 3): loaded only then
 * (`app/compensation/root-unwind.ts`); a lost lease or an interruption undoes nothing — another
 * instance goes on with the tree (#265). A pass's failure undoes before the root's record is failed
 * (#340 S7 3, `unwindingDeps`): while the undo runs the record stays `running`, so an instance that
 * stops or crashes mid-undo leaves it to the recovery sweep, which finishes it (PR 4).
 */

/** What the tree's error event is told of its undo (`ExecutionErrorEvent.compensations`). */
export interface EndedTreeUndo {
  compensations: readonly CompensationRecord[];
}

/** The error the tree ends with once its open entries are undone; `undo` gets the records. */
export async function undoneTreeEnd(
  deps: AppDeps,
  state: TreeState,
  failure: { readonly error: unknown; readonly signal: AbortSignal },
  undo: EndedTreeUndo,
): Promise<unknown> {
  if (isHandedOver(failure.error)) return failure.error;
  const { unwoundTree } = await import("./compensation/root-unwind.js");
  const done = await unwoundTree(deps, state, { cause: failure.error, signal: failure.signal });
  undo.compensations = done.compensations;
  return done.error;
}

/**
 * The run deps of one pass whose failure undoes the tree before the root's record is failed
 * (`CompensationParts.rootUnwind`); the undo stops on `at.signal` (a lost lease, the app's stop).
 */
export function unwindingDeps(
  deps: AppDeps,
  state: TreeState,
  at: { readonly signal: AbortSignal; readonly undo: EndedTreeUndo },
): AppDeps {
  const { compensation } = deps;
  if (compensation === undefined) return deps;
  const rootUnwind = (error: unknown): Promise<unknown> =>
    undoneTreeEnd(deps, state, { error, signal: at.signal }, at.undo);
  return { ...deps, compensation: { ...compensation, rootUnwind } };
}
