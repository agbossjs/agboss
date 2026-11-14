import type * as LostPassesAtTake from "./lost-passes-at-take.js";
import { lazyLoad } from "../infrastructure/clock.js";
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

/** One `onExecutionResume` event as `announceResume` tells it. */
interface Told {
  readonly reason: ResumeReason;
  readonly decision: unknown;
  readonly answeredBy: string | undefined;
}

const toldWithout = (reason: ResumeReason): Told => ({
  reason,
  decision: undefined,
  answeredBy: undefined,
});

/**
 * The events a pass is announced with: one per decision it takes, with its own reason — an answer
 * `Answered`, an expiry's decision `Expired` — and its `answeredBy` (#267 AC4); a recovery or an
 * expiry that takes none says so once (#941, V1: a pass whose pauses closed without an answer still
 * announces); a pass that takes an expiry that failed its step and no decision of an expiry says
 * `Expired` once more. A pass that only withdraws pauses is announced by nothing.
 */
function resumesToTell(reason: ResumeReason, resume: TreeResume | undefined): readonly Told[] {
  const decisions = resume?.decisions ?? [];
  const isNamed = reason === ResumeReason.Recovered || reason === ResumeReason.Expired;
  if (decisions.length === 0 && isNamed) return [toldWithout(reason)];
  // a recovery stays one reason for what it takes; any other pass says why each decision was taken
  const told = decisions.map((decision, index): Told => ({
    reason: reason === ResumeReason.Recovered ? reason : (resume?.reasons[index] ?? reason),
    decision,
    answeredBy: resume?.answeredBy[index],
  }));
  const hasExpiry = told.some((one) => one.reason === ResumeReason.Expired);
  const isExpiryMissing = resume?.hasUnansweredExpiry === true && !hasExpiry;
  return isExpiryMissing ? [...told, toldWithout(ResumeReason.Expired)] : told;
}

/** Announces a pass (`onExecutionResume`, once per event of `resumesToTell`). */
export async function announceResume(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
  reason: ResumeReason,
  resume: TreeResume | undefined,
): Promise<void> {
  for (const told of resumesToTell(reason, resume)) {
    await observer.onExecutionResume({ ...event, ...told });
  }
}

/** `call` with the passes a takeover's previous holders lost (#853), its reader loaded on first use. */
export const callWithLostPasses: typeof LostPassesAtTake.callWithLostPasses = async (...args) =>
  (await lazyLoad(import("./lost-passes-at-take.js"))).callWithLostPasses(...args);
