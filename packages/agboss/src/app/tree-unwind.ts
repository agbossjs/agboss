import type { CompensationRecord } from "../flow/compensation.js";
import type { AppDeps } from "./app-deps.js";
import { isHandedOver } from "./handed-over.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * The automatic undo of a tree whose pass rejected (#340 PR 3): loaded only then
 * (`app/compensation/root-unwind.ts`); a lost lease or an interruption undoes nothing — another
 * instance goes on with the tree (#265).
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

/** A tree's pass whose rejection first undoes the tree (`undo` gets the records for its event). */
export function undoingPass<TRun>(
  deps: AppDeps,
  state: TreeState,
  at: { readonly signal: AbortSignal; readonly undo: EndedTreeUndo },
  pass: () => Promise<TRun>,
): Promise<TRun> {
  return pass().catch(async (error: unknown) => {
    throw await undoneTreeEnd(deps, state, { error, signal: at.signal }, at.undo);
  });
}
