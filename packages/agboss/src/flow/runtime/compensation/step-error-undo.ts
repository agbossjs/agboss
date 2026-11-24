import type { UsageRecord } from "../../../finops/usage.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationFailedError,
  CompensationReason,
  type CompensationEntry,
} from "../../compensation.js";
import type { Clock } from "../../../infrastructure/clock.js";
import type { FrameSpec } from "../../context/frame.js";
import { rootFactsOf } from "../../context/frame.js";
import type { ExecutionStateType } from "../state.js";
import type { VisitDeps } from "../visit.js";
import { heldUndoSiteOf, isHeldOpen } from "./held-entries.js";
import { unwound } from "./unwind.js";
import { markUndone, withUndoneMarks, type UndoneMarks } from "./unwinding-marks.js";

/**
 * The automatic undo of what a plain step's failure leaves held from its children (#1281, D8): when a
 * step of a parent fails and its `.onError` takes the error, the open entries its finished children
 * moved up to it (`!isOwnEntry`, held by this execution) are undone BEFORE the side path's first node —
 * newest first by the tree's durable order, each in its child's own workflow and container, as a
 * failed join does — because a side path can name its own workflow's undo actions only, never a child's.
 * The parent's own entries stay the side path's to undo (`[flow.uncompensated-action]`). A child the
 * side path itself launches opens its entries after this, and commits them normally. Durable once like
 * every automatic undo (#607): each success is marked done in the tree's store before the next, and a
 * step run again after a crash reads the entries through the marks and undoes nothing twice.
 */

/** What the failed step's visit adds: the entries closed (as the undo ended) and the undo's spend. */
export interface HeldEntriesUndone {
  readonly compensations: readonly CompensationEntry[];
  readonly usage: readonly UsageRecord[];
}

/** Where a step's failure undoes what its children held. */
export interface StepErrorSite {
  readonly state: ExecutionStateType;
  readonly frame: FrameSpec;
  readonly deps: VisitDeps;
  readonly clock: Clock;
  /** The failure the `.onError` took: the cause of a `CompensationFailedError`. */
  readonly cause: unknown;
}

/**
 * Undoes the held child entries before the side path: the entries closed and the undo's spend for the
 * visit's update, or `CompensationFailedError` (never taken by a side path) when an undo failed.
 */
export async function undoneHeldEntries(site: StepErrorSite): Promise<HeldEntriesUndone> {
  const { state, frame, deps } = site;
  const { execution } = frame;
  const { executionId } = execution;
  const covers = isHeldOpen(executionId);
  const tree: ExecutionTree = {
    tenantId: execution.tenant.tenantId,
    rootExecutionId: rootFactsOf(execution).executionId,
  };
  const marks: UndoneMarks = { trees: deps.compensation?.trees, tree };
  const known = await withUndoneMarks(marks, state.compensations.filter(covers));
  const undo = {
    graph: deps.graph,
    container: deps.container,
    components: deps.components,
    observer: deps.observer,
    execution,
    clock: site.clock,
    timeout: deps.compensation?.timeout ?? COMPENSATION_TIMEOUT,
    stepEntries: deps.stepEntries,
    reason: CompensationReason.StepFailed,
  };
  const record = (usage: readonly UsageRecord[]): Promise<void> =>
    deps.limits.budgets.record(usage);
  const { closed, usage, failures } = await unwound({
    tree,
    covers,
    runs: () => false,
    known,
    undoSiteOf: (entry) => heldUndoSiteOf(undo, deps, entry),
    parts: deps.compensation,
    stepEntries: deps.stepEntries,
    clock: site.clock,
    timeout: undo.timeout,
    isSealing: false,
    record,
    onUndone: (entry) => markUndone(marks, entry),
  });
  if (failures.length > 0) {
    await record(usage);
    throw new CompensationFailedError({ failures, cause: site.cause });
  }
  // undone by an earlier pass of this visit: its mark closes it, nothing runs again
  const earlier = known.filter((entry) => entry.status === CompensationEntryStatus.Closed);
  return { compensations: [...earlier, ...closed], usage };
}
