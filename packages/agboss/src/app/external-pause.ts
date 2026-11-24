import { ExecutionError } from "../core/error-families/run-errors.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { ExecutionLeases } from "./execution-leases.js";

/**
 * The tree is paused from outside (#1341c, `app.pause`) while a business pause (`@ExternalTask`,
 * `@ToolApproval`) is open: `dual_paused`. Nothing but `app.unpause` moves it — an answer is refused,
 * an expiry is deferred, the sweep's wake of an answered pause waits — so an operator's freeze is
 * never undone by a timer or an answer. The mark is the lease row's, read from the database whatever
 * the coordination store says (D6).
 */

/** Whether the tree's lease row carries an external pause; a store that fails rejects. */
export async function isExternallyPaused(
  leases: Pick<ExecutionLeases, "pauseOf">,
  tree: ExecutionTree,
): Promise<boolean> {
  return (await leases.pauseOf(tree)).pause !== undefined;
}

/**
 * `app.resume` of an answer on a tree frozen from outside is refused before it is recorded
 * (`ExecutionError.ExternallyPaused`): stage 1 of the resume, so the pause stays open and the answer
 * can be given again once the operator unpauses.
 */
export async function assertNotExternallyPaused(
  leases: Pick<ExecutionLeases, "pauseOf"> | undefined,
  tree: ExecutionTree,
): Promise<void> {
  if (leases === undefined || !(await isExternallyPaused(leases, tree))) return;
  throw new ExecutionError.ExternallyPaused({
    message:
      "the execution is paused from outside (app.pause): app.unpause(threadId) first, then answer its pause again",
  });
}
