import type { GraphDeps } from "../../graph/deps.js";
import type { ChildEntered } from "./child-identity.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/**
 * A child re-entered while its automatic undo was under way (#340 PR 4, AC4): its instance stopped
 * mid-undo, and the parent's step runs again on the instance that took the tree over. Before the
 * child's next step its mark (`@agboss/unwinding:<childExecutionId>`) is read: found, the child
 * takes no step — its undo is finished (the undos marked done skipped) and its recorded error is
 * raised again. Loaded only on a re-entry of a child of a tree with keys. A failure is claimed there
 * too (#596) before it is announced, so an announced failure is never announced twice nor followed
 * by a finish.
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
  const { causeOfMark, childUnwindingKeyOf, unwindingOf } = await lazyLoad(
    import("./compensation/unwinding-marks.js"),
  );
  const tree = { tenantId, rootExecutionId };
  const mark = await unwindingOf(trees, tree, childUnwindingKeyOf(executionId));
  return mark === undefined ? undefined : causeOfMark(mark);
}

/**
 * The failure a re-entered child already ended with (#596): claimed and announced by an earlier
 * pass (`childFailureKeyOf`), raised again by name and message — its step never runs again, so an
 * announced failure never turns into a finish. `undefined` when none was claimed.
 */
export async function claimedFailureOf(
  deps: GraphDeps<string>,
  entered: ChildEntered,
  tenantId: string,
): Promise<unknown> {
  const trees = deps.compensation?.trees;
  if (entered.isNew || trees === undefined) return undefined;
  const { executionId, rootExecutionId } = entered.identity;
  const { causeOfMark, childFailureKeyOf, unwindingOf } = await lazyLoad(
    import("./compensation/unwinding-marks.js"),
  );
  const mark = await unwindingOf(
    trees,
    { tenantId, rootExecutionId },
    childFailureKeyOf(executionId),
  );
  return mark === undefined ? undefined : causeOfMark(mark);
}

/**
 * Whether this pass may announce the child's failure (#596): it wins the claim in the tree's store
 * (atomic), so of every pass that saw the failure — the first, a re-entry repeating it, one that
 * finished its interrupted undo — exactly one announces it. No tree keys: `true` (one instance).
 */
export async function isFailureClaimed(
  deps: GraphDeps<string>,
  identity: ChildEntered["identity"],
  tenantId: string,
  cause: unknown,
): Promise<boolean> {
  const trees = deps.compensation?.trees;
  if (trees === undefined) return true;
  const { claimChildFailure } = await lazyLoad(import("./compensation/unwinding-marks.js"));
  const tree = { tenantId, rootExecutionId: identity.rootExecutionId };
  return claimChildFailure(trees, tree, identity.executionId, cause);
}

/**
 * What a re-entered child's earlier passes left in the tree's keys: its undo under way (#340 PR 4),
 * else the failure it ended with (#596, repeated while it has not ended on its thread).
 */
export async function reentryOf(
  deps: GraphDeps<string>,
  entered: ChildEntered,
  tenantId: string,
): Promise<{ readonly interrupted: unknown; readonly claimed: unknown }> {
  const interrupted = await interruptedUndoOf(deps, entered, tenantId);
  if (interrupted !== undefined) return { interrupted, claimed: undefined };
  return { interrupted, claimed: await claimedFailureOf(deps, entered, tenantId) };
}
