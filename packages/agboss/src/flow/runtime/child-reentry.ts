import type { GraphDeps } from "../../graph/deps.js";
import type { ChildEntered } from "./child-identity.js";

/**
 * A child re-entered while its automatic undo was under way (#340 PR 4, AC4): its instance stopped
 * mid-undo, and the parent's step runs again on the instance that took the tree over. Before the
 * child's next step its mark (`@agboss/unwinding:<childExecutionId>`) is read: found, the child
 * takes no step — its undo is finished (the undos marked done skipped) and its recorded error is
 * raised again. Loaded only on a re-entry of a child of a tree with keys.
 */

/** The error the child's interrupted undo was for; `undefined` when none was under way. */
export async function interruptedUndoOf(
  deps: GraphDeps<string>,
  entered: ChildEntered,
  tenantId: string,
): Promise<unknown> {
  const trees = deps.compensation?.trees;
  if (entered.isNew || trees === undefined) return undefined;
  const { executionId, rootExecutionId } = entered.identity;
  const { causeOfMark, childUnwindingKeyOf, unwindingOf } =
    await import("./compensation/unwinding-marks.js");
  const tree = { tenantId, rootExecutionId };
  const mark = await unwindingOf(trees, tree, childUnwindingKeyOf(executionId));
  return mark === undefined ? undefined : causeOfMark(mark);
}
