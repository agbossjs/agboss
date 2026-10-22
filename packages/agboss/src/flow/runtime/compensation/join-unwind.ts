import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../../core/run-context.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationFailedError,
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

/**
 * The automatic undo of a failed join (#340 Q3, `CompensationReason.JoinFailed`): before its
 * `.onJoinError` side path runs — or the branch's error fails the execution — the launch's
 * finished undoable branches are undone, newest first. It first awaits the launch's branches whose
 * bodies still run (#340 Q-A, up to `compensationTimeout`), so one that returns meanwhile is undone
 * too; the entries are the state's and the instance registry's. An undo that fails does not stop
 * the others; then the execution fails with `CompensationFailedError` (its cause the branch's error),
 * which no side path takes — the undo's spend written to the ledger first (#340 S4).
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
function unwindSiteOf(site: JoinUnwindSite): UnwindSite {
  const undo = undoSiteOf(site);
  const { executionId } = undo.execution;
  const ids = new Set(site.ticket.branches.map((branch) => branch.nodeId));
  const covers = (entry: CompensationEntry): boolean =>
    entry.launchId === site.ticket.launchId && entry.executionId === executionId;
  return {
    tree: undo.tree,
    covers,
    runs: (entry) => entry.executionId === executionId && ids.has(entry.nodeId),
    known: site.state.compensations.filter(covers),
    undoSiteOf: () => undo,
    parts: site.deps.compensation,
    stepEntries: undo.stepEntries,
    clock: undo.clock,
    timeout: undo.timeout,
    isSealing: false,
    record: (usage) => site.deps.limits.budgets.record(usage),
  };
}

/**
 * Undoes the failed join's finished undoable branches, newest first: the entries closed and their
 * undo's spend for the join's update, or `CompensationFailedError` when one of them failed.
 */
export async function unwoundJoin(site: JoinUnwindSite): Promise<FailedJoinUndo> {
  const unwind = unwindSiteOf(site);
  const { closed, usage, failures } = await unwound(unwind);
  if (failures.length > 0) {
    await unwind.record(usage);
    throw new CompensationFailedError(failures, site.cause);
  }
  return { compensations: [...closed], usage: [...usage] };
}
