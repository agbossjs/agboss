import type { UsageRecord } from "../../../finops/usage.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationReason,
  type CompensationEntry,
  type HeldUndo,
  type HeldVisitSite,
} from "../../compensation.js";
import { rootFactsOf } from "../../context/frame.js";
import { unwound } from "./unwind.js";
import { markUndone, withUndoneMarks, type UndoneMarks } from "./unwinding-marks.js";

/**
 * The undo a held-back visit owes (#675): a visit of an undo action that a limit stopped before it
 * ran — the budget exhausted, its deadline passed —, whose `.onError` took the error. The visit
 * stays stopped (a step of the main path is no undo, #656), but the newest open entry it would
 * have closed is undone at once **as an undo**, the way the execution's automatic undo would have
 * done it without the handler: its own frame and key `<step key>:compensation`, its fence,
 * `compensationTimeout`, no slot and no budget check (the money has to go back) —
 * `CompensationReason.SidePath`, `Compensated`, or `Failed` with the undo's own error. Durable once
 * (#607): marked done in the tree's store (`@agboss/compensated/<compensationKey>`) before the
 * visit's update is written, and read through that mark first — a holder that runs the visit again
 * after a takeover finds it undone and closes the entry by its mark, without undoing again.
 */

/** The newest open entry the visit's undo action undoes; `undefined` when it undoes none. */
function owedEntryOf(site: HeldVisitSite): CompensationEntry | undefined {
  return site.entries
    .filter(
      (entry) =>
        entry.status === CompensationEntryStatus.Open && entry.compensator === site.node.id,
    )
    .sort((first, second) => first.sequence - second.sequence)
    .at(-1);
}

/** Undoes the entry the held-back visit would have closed: the entry closed and the undo's spend. */
export async function heldUndoOf(site: HeldVisitSite): Promise<HeldUndo> {
  const owed = owedEntryOf(site);
  if (owed === undefined) return {};
  const { execution } = site.frame;
  const tree = {
    tenantId: execution.tenant.tenantId,
    rootExecutionId: rootFactsOf(execution).executionId,
  };
  const marks: UndoneMarks = { trees: site.parts?.trees, tree };
  const known = await withUndoneMarks(marks, [owed]);
  const timeout = site.parts?.timeout ?? COMPENSATION_TIMEOUT;
  const { deps } = site;
  const undoSite = {
    ...{ graph: deps.graph, container: deps.container, components: deps.components },
    observer: deps.observer,
    execution,
    clock: site.clock,
    timeout,
    stepEntries: deps.stepEntries,
    reason: CompensationReason.SidePath,
  };
  const { closed, usage } = await unwound({
    tree,
    covers: (entry) => entry.key === owed.key,
    runs: () => false,
    known,
    undoSiteOf: () => undoSite,
    parts: site.parts,
    stepEntries: deps.stepEntries,
    clock: site.clock,
    timeout,
    isSealing: false,
    record: (spent: readonly UsageRecord[]) => deps.limits.budgets.record(spent),
    onUndone: (entry) => markUndone(marks, entry),
  });
  // undone by an earlier pass of this visit (#607): its mark closes it, nothing runs again
  const earlier = known.filter((entry) => entry.status === CompensationEntryStatus.Closed);
  return { compensations: [...earlier, ...closed], usage: [...usage] };
}
