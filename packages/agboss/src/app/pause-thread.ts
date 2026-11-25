import { ExecutionOperation } from "../core/observability.js";
import { InvalidThreadIdError, keyTextRuleOf } from "../core/errors.js";
import { ExecutionError } from "../core/error-families/run-errors.js";
import { checkedCallerId, checkedTenantId } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { StatusTrigger, ThreadStatus, type NewStatusTransition } from "../turns/index.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { CancelThreadParts } from "./cancel-thread.js";
import { requestChecksOf } from "./request-checks.js";
import {
  InterruptMode,
  PauseRequestState,
  type PauseExecutionOptions,
  type PauseOutput,
} from "./interrupt-types.js";

/**
 * `app.pause(threadId, { tenantId, ownerId, reason, mode })` (#1341c): the thread's execution is
 * frozen from outside — nothing is undone, its checkpoint is kept — until `app.unpause`. A run on this
 * instance is marked and told at once (`mode` `Immediate` aborts the step in flight and fences the
 * tree's token, `AfterStep`, the default, lets the step finish and starts none); one on another
 * instance gets the mark its holder reads at its next renewal; one that rests at a business pause
 * (`@ExternalTask`, `@ToolApproval`) is `dual_paused`: no answer, expiry or channel decision moves it
 * before `app.unpause`. The mark is the lease row's, with its history row in one transaction, and is
 * written again by every call: an operator's retry completes one that died half way. `Cancel > Stop >
 * Pause`: a thread with a cancel or stop request refuses (`ExecutionError.AlreadyTerminal`), one that
 * ended or never ran answers `NotRunning`.
 */
export async function pauseThread(
  parts: CancelThreadParts,
  threadId: string,
  options: PauseExecutionOptions,
): Promise<PauseOutput> {
  const { live, leases } = parts;
  const thread = { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, threadId };
  await parts.admit({ operation: ExecutionOperation.Pause, ...thread }, () => {
    checkedTenantId(thread.tenantId);
    const rule = keyTextRuleOf(threadId);
    if (rule !== undefined) throw new InvalidThreadIdError({ rule });
    checkedCallerId("PauseExecutionOptions", "ownerId", options.ownerId);
    return parts.known({ ...thread, ownerId: options.ownerId });
  });
  const mode = options.mode ?? InterruptMode.AfterStep;
  const request = { mode, ...(options.reason === undefined ? {} : { reason: options.reason }) };
  const mark: Mark = async (tree, status) => {
    await assertNotEnding(leases, tree, threadId);
    const transition = pauseTransitionOf(thread, status, options);
    await leases.requestPause(tree, request, transition);
  };
  // a tree moved here: marked first, then its holder is told at once
  const trees = live.treesOf(thread);
  for (const tree of trees) await mark(tree, ThreadStatus.Pausing);
  if (trees.length > 0) {
    await requestChecksOf(live).checked(thread);
    return { state: PauseRequestState.Pausing };
  }
  return { state: await storedRootsMarked(parts, thread, mark) };
}

type Mark = (tree: ExecutionTree, status: ThreadStatus) => Promise<void>;

/**
 * The roots of the thread that are not moved on this instance: a running root belongs to a holder
 * elsewhere (marked for its next renewal), a resting one is frozen now. What the thread is, after.
 */
async function storedRootsMarked(
  parts: CancelThreadParts,
  thread: { readonly tenantId: string; readonly threadId: string },
  mark: Mark,
): Promise<PauseRequestState> {
  const records = await parts.deps.turns.lastTurns(thread.tenantId, thread.threadId, 20);
  const own = records.filter((record) => record.workflow === parts.deps.config.name);
  let state: PauseRequestState = PauseRequestState.NotRunning;
  for (const record of own) {
    if (record.runId === null) continue;
    const tree = { tenantId: thread.tenantId, rootExecutionId: record.runId };
    if (record.status === "running") {
      await mark(tree, ThreadStatus.Pausing);
      state = PauseRequestState.Pausing;
    } else if (record.status === "paused") {
      // a business pause open (the paused run is stored) or a tree parked by an earlier pause
      const isBusiness = (await parts.paused.find(thread))?.run.runId === record.runId;
      await mark(tree, isBusiness ? ThreadStatus.DualPaused : ThreadStatus.ExternallyPaused);
      if (state !== PauseRequestState.Pausing) state = PauseRequestState.Paused;
    }
  }
  return state;
}

/** A tree with a cancel or stop request is ending: `Cancel > Stop > Pause`, a pause is refused. */
async function assertNotEnding(
  leases: CancelThreadParts["leases"],
  tree: ExecutionTree,
  threadId: string,
): Promise<void> {
  const { isCancelRequested, stop } = await leases.markedOf(tree);
  if (!isCancelRequested && stop === undefined) return;
  throw new ExecutionError.AlreadyTerminal({
    message: `thread "${threadId}" is being ${isCancelRequested ? "cancelled" : "stopped"}: it cannot be paused`,
  });
}

/** The history row of a pause request (#1341d): the thread is `Pausing` (a run), `DualPaused` or `ExternallyPaused` (a rest). */
function pauseTransitionOf(
  thread: { readonly tenantId: string; readonly threadId: string },
  toStatus: ThreadStatus,
  request: { readonly ownerId?: string | undefined; readonly reason?: string | undefined },
): NewStatusTransition {
  return {
    tenantId: thread.tenantId,
    threadId: thread.threadId,
    toStatus,
    trigger: StatusTrigger.Pause,
    ...(request.ownerId === undefined ? {} : { actor: request.ownerId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}
