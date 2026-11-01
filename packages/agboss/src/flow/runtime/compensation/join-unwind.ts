import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../../core/run-context.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationFailedError,
  CompensationEntryStatus,
  CompensationReason,
  type CompensationEntry,
  type FailedJoinUndo,
} from "../../compensation.js";
import { rootFactsOf } from "../../context/frame.js";
import type { JoinDeps } from "../launch/join-node.js";
import type { LaunchTicket } from "../launch/records.js";
import type { ExecutionStateType } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import type { UndoSite } from "./undo.js";
import { unwound, type UnwindSite } from "./unwind.js";
import { markUndone, withUndoneMarks, type UndoneMarks } from "./unwinding-marks.js";

/**
 * The automatic undo of a failed join (#340 Q3, `CompensationReason.JoinFailed`): before its
 * `.onJoinError` side path runs — or the branch's error fails the execution — the launch's
 * finished undoable branches are undone, newest first. It first awaits the launch's branches whose
 * bodies still run (#340 Q-A, up to `compensationTimeout`), so one that returns meanwhile is undone
 * too; the entries are the state's and the instance registry's. An undo that fails does not stop
 * the others; then the execution fails with `CompensationFailedError` (its cause the branch's error),
 * which no side path takes — the undo's spend written to the ledger first (#340 S4). Durable once
 * (#607): each undo that succeeded is marked done in the tree's store
 * (`@agboss/compensated/<compensationKey>`) before the next undo starts and before the join's update
 * or error is written, and the entries are read through those marks first — so a holder that takes
 * the tree over and runs the launch's superstep again, or undoes the root, skips what was undone.
 */

/** Where a failed join undoes: its state, config, launch, deps, and the branch's error. */
export interface JoinUnwindSite {
  readonly state: ExecutionStateType;
  readonly config: RunnableConfig | undefined;
  readonly ticket: LaunchTicket;
  readonly deps: JoinDeps;
  /** The error the join fails with: the cause of a `CompensationFailedError`. */
  readonly cause: unknown;
}

/** The undo site of the join: the launching step's execution, the instance's parts. */
function undoSiteOf(site: JoinUnwindSite): UndoSite & { readonly tree: ExecutionTree } {
  const { state, config, ticket, deps } = site;
  const node = deps.graph.nodes.get(ticket.launcher);
  if (node === undefined) throw new TypeError(`${ticket.launcher} is not a node of the graph`);
  const { execution } = stepFrameAt({ node, visitNumber: ticket.visitNumber }, state, config, deps);
  const tree = {
    tenantId: execution.tenant.tenantId,
    rootExecutionId: rootFactsOf(execution).executionId,
  };
  return {
    ...{ graph: deps.graph, container: deps.container, components: deps.components },
    observer: deps.observer,
    execution,
    clock: extractRunContext(config, state.runId).clock,
    timeout: deps.compensation?.timeout ?? COMPENSATION_TIMEOUT,
    stepEntries: deps.stepEntries,
    reason: CompensationReason.JoinFailed,
    tree,
  };
}

/** The join's unwind: its launch's entries and branches, never sealed (the execution goes on). */
async function unwindSiteOf(site: JoinUnwindSite): Promise<UnwindSite> {
  const undo = undoSiteOf(site);
  const { executionId } = undo.execution;
  const ids = new Set(site.ticket.branches.map((branch) => branch.nodeId));
  const covers = (entry: CompensationEntry): boolean =>
    entry.launchId === site.ticket.launchId && entry.executionId === executionId;
  const marks: UndoneMarks = { trees: site.deps.compensation?.trees, tree: undo.tree };
  return {
    tree: undo.tree,
    covers,
    runs: (entry) => entry.executionId === executionId && ids.has(entry.nodeId),
    known: await withUndoneMarks(marks, site.state.compensations.filter(covers)),
    undoSiteOf: () => undo,
    parts: site.deps.compensation,
    stepEntries: undo.stepEntries,
    clock: undo.clock,
    timeout: undo.timeout,
    isSealing: false,
    record: (usage) => site.deps.limits.budgets.record(usage),
    onUndone: (entry) => markUndone(marks, entry),
  };
}

/**
 * Undoes the failed join's finished undoable branches, newest first: the entries closed and their
 * undo's spend for the join's update, or `CompensationFailedError` when one of them failed.
 */
export async function unwoundJoin(site: JoinUnwindSite): Promise<FailedJoinUndo> {
  const unwind = await unwindSiteOf(site);
  const { closed, usage, failures } = await unwound(unwind);
  if (failures.length > 0) {
    await unwind.record(usage);
    throw new CompensationFailedError(failures, site.cause);
  }
  return { compensations: [...undoneEarlier(site, unwind), ...closed], usage: [...usage] };
}

/**
 * The entries an earlier pass undid (#607), closed by their marks: the state still holds them open
 * (that pass's update never became durable), so the join's update closes them — a finish never
 * commits what was undone, and the execution's records list each undo once.
 */
function undoneEarlier(site: JoinUnwindSite, unwind: UnwindSite): readonly CompensationEntry[] {
  const open = new Set(
    site.state.compensations
      .filter((entry) => entry.status === CompensationEntryStatus.Open)
      .map((entry) => entry.key),
  );
  return unwind.known.filter(
    (entry) => entry.status === CompensationEntryStatus.Closed && open.has(entry.key),
  );
}
