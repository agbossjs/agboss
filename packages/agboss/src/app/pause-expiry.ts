import { isPauseExpiration, PauseExpirationKind } from "../channels/pause-expiration.js";
import type { ChannelSender } from "../channels/channel-sender.js";
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
import { treeQuestionAnswersOf, treeToolsOf } from "./child-deps.js";
import { callInFrame, NoticeTimeoutError } from "./pause-notice-call.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";
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
  const at = now.toISOString();
  return (records ?? []).filter(
    (pause) =>
      pause.status === PauseStatus.Pending &&
      pause.expiresAt !== undefined &&
      pause.expiresAt <= at,
  );
}

const FAILED: PauseExpiry = {};

/** What a channel's expiry decision came to: the expiry to record, or why it fell back to `fail()`. */
function fellBackTo(parts: TreeMoveParts, pause: PauseRecord, problem: ExpiryProblem): PauseExpiry {
  const text = `pause expiry decision of channel ${pause.channel} fell back to fail(): ${problem}`;
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

/** The decision a returned value is: `fail()`, or `decide(answer)` validated like a resume's. */
function decisionOf(parts: TreeMoveParts, pause: PauseRecord, value: unknown): PauseExpiry {
  if (!isPauseExpiration(value)) return fellBackTo(parts, pause, ExpiryProblem.HandlerFailed);
  if (value.kind === PauseExpirationKind.Fail) return FAILED;
  try {
    const checks = { tools: treeToolsOf(parts.deps), questions: treeQuestionAnswersOf(parts.deps) };
    const decision = answerValidatorOf(pause, checks)(value.answer);
    return { answer: { decision, answeredBy: undefined } };
  } catch {
    return fellBackTo(parts, pause, ExpiryProblem.AnswerInvalid);
  }
}

/** The channel's decision of what the expiry of `pause` means, called in the pause's frame under its timeout. */
async function askedChannel(
  parts: TreeMoveParts,
  decide: NonNullable<ChannelSender["onPauseExpired"]>,
  pause: PauseRecord,
  interruption: AbortSignal | undefined,
): Promise<PauseExpiry> {
  const { deps } = parts;
  const own = ownDepsOf(deps, pause.workflow);
  const timeout = isApprovalPause(pause) ? own.tools(pause.ask.tool).timeout : DEFAULT_TOOL_TIMEOUT;
  // the frame is read from the stores outside the handler's try: a store that fails is the look's
  // to retry, never a decision recorded against the channel
  const tree = await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId));
  const frame = pauseFrameOf(deps, pause, tree);
  try {
    const value = await callInFrame(
      { frame, timeout, clock: parts.clock, interruption },
      async () => decide({ pauseId: pause.pauseId, value: pause.ask }),
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

/** The channel that sent `pause`; `undefined` when a deploy removed it (its pause expires as `fail()`). */
function senderOf(parts: TreeMoveParts, pause: PauseRecord): ChannelSender | undefined {
  try {
    return ownDepsOf(parts.deps, pause.workflow).channelOf?.(pause.channel).sender;
  } catch {
    return undefined;
  }
}

/** What the expiry of one pause records: none from a bound that is not its own, else its channel's decision. */
async function expiryOf(
  parts: TreeMoveParts,
  pause: PauseRecord,
  interruption: AbortSignal | undefined,
): Promise<PauseExpiry> {
  if (
    pause.expiryBound === PauseExpiryBound.RunDeadline ||
    pause.expiryBound === PauseExpiryBound.Quorum
  )
    return FAILED;
  const sender = senderOf(parts, pause);
  if (sender?.onPauseExpired === undefined) return FAILED;
  return askedChannel(parts, (ask) => sender.onPauseExpired?.(ask), pause, interruption);
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
    const expiry = await expiryOf(parts, pause, interruption);
    // ...and one requested while the handler ran: its decision is dropped, the cancel ends the tree
    if (await isCancelRequested(parts.trees, tree)) break;
    const applied = await stores.pauses.expireByTenantIdAndPauseId(
      pause.tenantId,
      pause.pauseId,
      expiry,
      parts.clock.now(),
      recipientsIn(stores, pause),
    );
    if (applied === undefined) continue;
    noticesWritten(stores);
    await logPauseAnswer(stores.answers, applied, applied.resolution ?? PauseResolution.Expired);
    closed += 1;
  }
  return closed;
}
