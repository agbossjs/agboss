import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../../core/run-context.js";
import { timeoutError, timeoutOn } from "../../../infrastructure/clock-timeout.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
} from "../../compensation.js";
import { rootFactsOf } from "../../context/frame.js";
import type { JoinDeps } from "../launch/join-node.js";
import type { LaunchTicket } from "../launch/records.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { stepFrameAt } from "../step-frame.js";
import { undone, type Undone, type UndoSite } from "./undo.js";

/**
 * The automatic undo of a failed join (#340 Q3, `CompensationReason.JoinFailed`): before its
 * `.onJoinError` side path runs — or the branch's error fails the execution — the launch's
 * finished undoable branches are undone, newest first. It first awaits the launch's branches whose
 * bodies still run (#340 Q-A, up to `compensationTimeout`), so one that returns meanwhile is undone
 * too; the entries are the state's and the instance registry's. An undo that fails does not stop
 * the others; then the execution fails with `CompensationFailedError` (its cause the branch's error),
 * which no side path takes.
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

/** The launch's open entries: the state's, then the registry's it does not hold yet. */
function openOfLaunch(site: JoinUnwindSite, tree: ExecutionTree, executionId: string) {
  const isOfLaunch = (entry: CompensationEntry): boolean =>
    entry.launchId === site.ticket.launchId && entry.executionId === executionId;
  const known = site.state.compensations.filter(isOfLaunch);
  const keys = new Set(known.map((entry) => entry.key));
  const mirrored = site.deps.compensation?.registry.entriesOf(tree, isOfLaunch) ?? [];
  return [...known, ...mirrored.filter((entry) => !keys.has(entry.key))]
    .filter((entry) => entry.status === CompensationEntryStatus.Open)
    .sort((first, second) => second.sequence - first.sequence);
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

/** Awaits the launch's branches still running, up to the bound. */
async function branchesSettled(
  site: JoinUnwindSite,
  undo: UndoSite & { readonly tree: ExecutionTree },
): Promise<void> {
  if (undo.stepEntries === undefined) return;
  const ids = new Set(site.ticket.branches.map((branch) => branch.nodeId));
  const { executionId } = undo.execution;
  const bound = timeoutOn(undo.clock, undo.timeout, timeoutError);
  try {
    await undo.stepEntries.closedWhere(
      undo.tree,
      (entry) => entry.executionId === executionId && ids.has(entry.nodeId),
      bound.signal,
    );
  } finally {
    bound.release();
  }
}

/**
 * Undoes the failed join's finished undoable branches, newest first: the entries closed and their
 * undo's spend for the join's update, or `CompensationFailedError` when one of them failed.
 */
export async function unwoundJoin(site: JoinUnwindSite): Promise<ExecutionStateUpdate> {
  const undo = undoSiteOf(site);
  await branchesSettled(site, undo);
  const ran: Undone[] = [];
  for (const entry of openOfLaunch(site, undo.tree, undo.execution.executionId))
    ran.push(await undone(entry, undo));
  const closed = ran.map((each) => each.entry);
  site.deps.compensation?.registry.write(undo.tree, closed);
  const failures = closed.flatMap((entry) =>
    entry.undo?.status === CompensationStatus.Failed ? [entry.undo] : [],
  );
  if (failures.length > 0) throw new CompensationFailedError(failures, site.cause);
  return { compensations: closed, usage: ran.flatMap((each) => [...each.usage]) };
}
