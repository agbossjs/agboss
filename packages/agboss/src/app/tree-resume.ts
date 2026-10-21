import { ResumeReason } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { ExecutionEvent } from "../flow/observers/execution-event.js";
import { readingGraphOf } from "../run/run-budgets.js";
import { treeResumeOf, type TreeResume } from "../run/resume-map.js";
import { waitingInterruptsOf } from "../run/waiting-pauses.js";
import type { AgentExecutionDeps } from "../run/types.js";

/**
 * What a tree's lease holder continues it with (#267 S35, Q58): the answers its waiting pauses have
 * now — read from the shared stores, so it holds whichever instance or call recorded them.
 */

/** A tree as its stores key it: its tenant and its root execution (the run). */
export interface TreeRun {
  readonly tenantId: string;
  readonly runId: string;
}

/** The tree's resume now; `undefined` when none of its waiting pauses has an answer. */
export async function treeResumeNow(
  deps: AgentExecutionDeps<string>,
  tree: TreeRun,
  passed?: ReadonlySet<string>,
): Promise<TreeResume | undefined> {
  if (deps.pause === undefined) return undefined;
  const interrupts = await waitingInterruptsOf(readingGraphOf(deps), tree.runId);
  if (interrupts.length === 0) return undefined;
  const records = await deps.pause.pauses.findAllByTenantIdAndRootExecutionId(
    tree.tenantId,
    tree.runId,
  );
  return treeResumeOf(interrupts, records, passed);
}

/** Marks the pauses a pass took `Taken`, once their steps are stored (the pass returned). */
export async function markTaken(
  deps: AgentExecutionDeps<string>,
  resume: TreeResume,
): Promise<void> {
  for (const { tenantId, pauseId } of resume.taken) {
    await deps.pause?.pauses.markTakenByTenantIdAndPauseId(tenantId, pauseId);
  }
}

/**
 * One `onExecutionResume` per decision a pass takes (its `answeredBy` with it, #267 AC4); a recovery
 * that takes none says so once. A pass that only withdraws pauses is announced by nothing.
 */
export async function announceResume(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
  reason: ResumeReason,
  resume: TreeResume | undefined,
): Promise<void> {
  if (resume === undefined) {
    if (reason !== ResumeReason.Recovered) return;
    await observer.onExecutionResume({
      ...event,
      reason,
      decision: undefined,
      answeredBy: undefined,
    });
    return;
  }
  for (const [index, decision] of resume.decisions.entries()) {
    const answeredBy = resume.answerers[index];
    await observer.onExecutionResume({ ...event, reason, decision, answeredBy });
  }
}
