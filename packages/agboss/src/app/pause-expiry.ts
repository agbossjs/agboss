import { copyOf, isDeadlineDue } from "../infrastructure/instants.js";
import { effectiveBoundOf } from "../infrastructure/pause-bound.js";
import { isPauseExpiration, PauseExpirationKind } from "../channels/pause-expiration.js";
import { movedOnExpiry, reassignmentOf, type ExpiryOutcome } from "./pause-expiry-reassign.js";
import type { ExpiredContext } from "../channels/pause-contexts.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import { answerValidatorOf } from "../channels/decision.js";
import {
  ExpiryProblem,
  isApprovalPause,
  logPauseAnswer,
  pauseKeyOf,
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseExpiry,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { DEFAULT_TOOL_TIMEOUT } from "../tools/index.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { treeQuestionAnswersOf, treeToolsOf } from "./child-deps.js";
import { callInFrame, NoticeTimeoutError } from "./pause-notice-call.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";
import { trailOf } from "../flow/runtime/pause-chain.js";
import { ownDepsOf } from "./own-deps.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";

/**
 * Expiring the pauses of one tree (#941), under the tree's lease: the pending pauses whose deadline
 * passed are read, each one's channel asked what the expiry means — `PauseExpiration.fail()` or
 * `decide(answer)` — and the decision recorded by the store's compare-and-set (`expire`, I1): one
 * decision whatever instances raced, a handler that ran twice (a crash before the record) loses to
 * the first. A pause bound by the run's deadline or a quorum's is expired with no handler (D8).
 * The handler's problems never fail the run: the pause expires as `fail()`, the fixed problem kept.
 */

/** The tree's pending pauses whose deadline passed at `now`, in the store's order. */
export async function duePausesOf(
  parts: Pick<TreeMoveParts, "deps">,
  tree: Pick<TreeState, "tenantId" | "runId">,
  now: Date,
): Promise<readonly PauseRecord[]> {
  const records = await parts.deps.pause?.pauses.findAllByTenantIdAndRootExecutionId(
    tree.tenantId,
    tree.runId,
  );
  if (records === undefined) return [];
  return records.filter(
    (pause) => pause.status === PauseStatus.Pending && isDeadlineDue(pause.expiresAt, now),
  );
}

const FAILED: PauseExpiry = {};

/** What a channel's expiry decision came to: the expiry to record, or why it fell back to `fail()`. */
function fellBackTo(parts: TreeMoveParts, pause: PauseRecord, problem: ExpiryProblem): PauseExpiry {
  const text = `pause expiry decision of target ${pause.target} fell back to fail(): ${problem}`;
  parts.deps.log.warn(
    "pause.expiry-handler-failed",
    `${text} (pauseKey ${pauseKeyOf(pause.tenantId, pause.pauseId)})`,
    {
      tenantId: pause.tenantId,
      executionId: pause.rootExecutionId,
    },
  );
  return { problem };
}

/** The decision a returned value is: `fail()`, `decide(answer)` validated like a resume's, or a reassignment. */
function decisionOf(parts: TreeMoveParts, pause: PauseRecord, value: unknown): ExpiryOutcome {
  if (!isPauseExpiration(value)) return fellBackTo(parts, pause, ExpiryProblem.HandlerFailed);
  if (value.kind === PauseExpirationKind.Fail) return FAILED;
  if (value.kind === PauseExpirationKind.Reassign)
    return reassignmentOf(value) ?? fellBackTo(parts, pause, ExpiryProblem.AnswerInvalid);
  try {
    const checks = { tools: treeToolsOf(parts.deps), questions: treeQuestionAnswersOf(parts.deps) };
    const decision = answerValidatorOf(pause, checks)(value.answer);
    return { answer: { decision, actor: undefined } };
  } catch {
    return fellBackTo(parts, pause, ExpiryProblem.AnswerInvalid);
  }
}

/** What the expiry of `pause` means, as its target says: called in the pause's frame under its timeout. */
async function askedTarget(
  parts: TreeMoveParts,
  decide: NonNullable<PauseTarget["onExpired"]>,
  pause: PauseRecord,
  interruption: AbortSignal | undefined,
): Promise<ExpiryOutcome> {
  const { deps } = parts;
  const own = ownDepsOf(deps, pause.workflow);
  const timeout = isApprovalPause(pause)
    ? own.tools(pause.toolCall.tool).timeout
    : DEFAULT_TOOL_TIMEOUT;
  // the frame is read from the stores outside the handler's try: a store that fails is the look's
  // to retry, never a decision recorded against the target
  const tree = await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId));
  const frame = pauseFrameOf(deps, pause, tree);
  try {
    const context = expiredContextOf(pause);
    const value = await callInFrame(
      { frame, timeout, clock: parts.clock, interruption },
      async () => decide(context as never),
    );
    return decisionOf(parts, pause, value);
  } catch (error) {
    // the instance stops: no decision is recorded, the pause stays pending for the next look
    if (interruption?.aborted === true) throw error;
    const isTimeout = error instanceof NoticeTimeoutError;
    return fellBackTo(
      parts,
      pause,
      isTimeout ? ExpiryProblem.HandlerTimeout : ExpiryProblem.HandlerFailed,
    );
  }
}

/**
 * What `onExpired` reads of the pause that ran out its deadline: `maxExpiresAt` is the latest
 * instant the pause's record lets it wait until (its `maxTotalTimeout` limits, materialized when it was
 * opened and narrowed by moves; absent: no limit), so a handler can tell whether a reassignment still has room.
 */
function expiredContextOf(pause: PauseRecord): ExpiredContext<never> {
  return {
    pauseKey: pauseKeyOf(pause.tenantId, pause.pauseId),
    input: pause.input as never,
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    askedAt: copyOf(pause.askedAt),
    firstAskedAt: copyOf(pause.firstAskedAt),
    expiresAt: copyOf(pause.expiresAt ?? pause.askedAt),
    ...(pause.maxExpiresAt === undefined ? {} : { maxExpiresAt: copyOf(pause.maxExpiresAt) }),
    ...(pause.toolCall === undefined ? {} : { toolCall: pause.toolCall }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    trail: trailOf(pause),
  };
}

/** The target of `pause` in its workflow now; `undefined` when a deploy removed it (its pause expires as `fail()`). */
function targetOf(parts: TreeMoveParts, pause: PauseRecord): PauseTarget | undefined {
  try {
    return ownDepsOf(parts.deps, pause.workflow).targetOf?.(pause.target);
  } catch {
    // a target a deploy removed: no handler
    return undefined;
  }
}

/** What the expiry of one pause records: none from a bound that is not its own, else its channel's decision. */
async function expiryOf(
  parts: TreeMoveParts,
  pause: PauseRecord,
  interruption: AbortSignal | undefined,
): Promise<ExpiryOutcome> {
  const bound = effectiveBoundOf(pause);
  if (bound === PauseExpiryBound.RunDeadline || bound === PauseExpiryBound.Quorum) return FAILED;
  const handler = targetOf(parts, pause)?.onExpired;
  if (handler === undefined) return FAILED;
  return askedTarget(parts, handler, pause, interruption);
}

/** The pause expired with `expiry` by the store's compare-and-set: its notices, its tally, its answer logged; `false` when it closed meanwhile. */
async function expiredPause(
  parts: TreeMoveParts,
  pause: PauseRecord,
  expiry: PauseExpiry,
): Promise<boolean> {
  const stores = parts.deps.pause;
  const applied = await stores?.pauses.expireByTenantIdAndPauseId(
    pause.tenantId,
    pause.pauseId,
    expiry,
    parts.clock.now(),
    recipientsIn(stores, pause),
  );
  if (stores === undefined || applied === undefined) return false;
  noticesWritten(stores);
  pauseTallyOf(stores)?.closed(applied);
  await logPauseAnswer(stores.answers, applied, applied.resolution ?? PauseResolution.Expired);
  return true;
}

/**
 * Expires each pause of `due` the store still holds pending: the decision recorded, its notices
 * written with it, the answer logged. Returns how many closed (a pause that closed meanwhile —
 * the CAS refused — counts none).
 */
export async function expirePauses(
  parts: TreeMoveParts,
  due: readonly PauseRecord[],
  interruption?: AbortSignal,
): Promise<number> {
  const stores = parts.deps.pause;
  if (stores === undefined) return 0;
  let closed = 0;
  const { isCancelRequested } = await lazyLoad(import("./cancel-requests.js"));
  for (const pause of due) {
    const tree = { tenantId: pause.tenantId, rootExecutionId: pause.rootExecutionId };
    // a cancel always beats an expiry (#941): once requested, no decision is asked or recorded
    if (await isCancelRequested(parts.trees, tree)) break;
    const outcome = await expiryOf(parts, pause, interruption);
    // ...and one requested while the handler ran: its decision is dropped, the cancel ends the tree
    if (await isCancelRequested(parts.trees, tree)) break;
    const moved = await movedOnExpiry(parts, pause, outcome);
    if (moved === "done") closed += 1;
    if (moved !== "failed") continue;
    const expiry: PauseExpiry = "reassign" in outcome ? FAILED : outcome;
    if (await expiredPause(parts, pause, expiry)) closed += 1;
  }
  return closed;
}
