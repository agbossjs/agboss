import { isChannelOutcome, ChannelOutcomeKind } from "../channels/channel-outcome.js";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../core/errors.js";
import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { sentBy, type PauseChannel } from "../flow/runtime/pause.js";
import { askOfPause } from "../flow/runtime/pause-chain.js";
import type { ResendReassigned } from "../application/pause-resend-look.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import {
  isApprovalPause,
  newPauseId,
  pauseKeyOf,
  PauseStatus,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { reassignedPause } from "../infrastructure/pause-replacement.js";
import { DEFAULT_TOOL_TIMEOUT } from "../tools/index.js";
import type { AppDeps } from "./app-deps.js";
import type { ChannelDecision } from "./channel-decision.js";
import { errorNamesOf } from "./error-names.js";
import { ownDepsOf } from "./own-deps.js";
import { callInFrame } from "./pause-notice-call.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";
import { pauseClosed } from "./pause-closed.js";
import type { AnswerParts } from "./resume.js";
import { answeredByOf, pauseOf } from "./resume.js";
import type { AnyTenantApp, PauseCallerOptions, ReassignPauseRequest } from "./types.js";

/**
 * `app.reassignPause` (#946, Q5): an operator moves an open pause to another addressee — the same
 * channel, asked again with a new pause id, `ChannelAsk.assignee` and `ChannelAsk.replaces`. Who may:
 * as an answer (`answeredBy` for a channel's pause, the thread's `ownerId` for its owner's). A closed
 * pause, or one past its deadline, is `PauseClosedError` — judged at the instant of the write, in the
 * store's one transaction, which makes the old pause `Cancelled / Reassigned`, the replacement
 * `Pending` with the old deadline, and writes the old pause's `closed (Reassigned)` notices: of two
 * reassignments, or a reassignment and an answer, exactly one wins. After the transaction the call
 * asks the channel in the pause's frame and marks the replacement sent; a call that dies, or whose
 * channel fails, between the two leaves it unsent for the re-send look (`pause-resend-look.ts`):
 * `send` is at-least-once, as a step's re-entry after a crash already is. No order is imposed on the
 * channel's two notices (Q12). The new id goes to the channel only: never to the caller, a log or a
 * listener without `allowAnswering`. No lease is taken, no tree moves, the agent does not run again.
 */

/** What a reassignment needs from the workflow's app. */
export interface ReassignParts extends Pick<AnswerParts, "owned"> {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The workflow's deps: its channels and who hears of the pause's changes (#940). */
  readonly deps: AppDeps;
  readonly decide: ChannelDecision;
}

/** What asking a replacement's channel needs: the app's deps, store and clock, and a stop. */
export interface ResendParts {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  readonly deps: AppDeps;
  /** The instance's interruption: a stop that ends the call (the replacement stays unsent for another instance). */
  readonly interruption?: AbortSignal | undefined;
  /** A channel that decides at once for the replacement answers it through this (the channel's own decision). */
  readonly decide: ChannelDecision;
}

function reject(issues: readonly DtoIssue[]): never {
  throw new DtoValidationError({ dto: "ReassignPauseRequest", issues });
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id and an assignee (a key's text). */
function checked(request: unknown): ReassignPauseRequest {
  const read = (field: string): unknown =>
    typeof request === "object" && request !== null ? Reflect.get(request, field) : undefined;
  const pauseId = read("pauseId");
  const assignee = read("assignee");
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  const rule = typeof assignee === "string" ? keyTextRuleOf(assignee) : undefined;
  if (typeof assignee !== "string" || rule !== undefined)
    reject([
      {
        path: ".assignee",
        reason:
          rule === undefined
            ? "an assignee is a key's text: a non-empty text"
            : `an assignee is a key's text (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`,
      },
    ]);
  return { pauseId, assignee };
}

/** The pause's channel as its workflow has it now; `undefined`: it is gone. */
function channelOf(deps: AppDeps, pause: PauseRecord): PauseChannel | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).channelOf?.(pause.channel);
  } catch {
    return undefined;
  }
}

/**
 * Asks the replacement's channel in the pause's frame (its tenant, fields and step, under its tool's
 * timeout) with `assignee` and `replaces`, then marks it sent; a channel that decides at once answers it.
 */
export async function sendReplacement(parts: ResendParts, pause: PauseRecord): Promise<void> {
  const { deps, clock } = parts;
  const channel = channelOf(deps, pause);
  if (channel === undefined)
    throw new TypeError(`no channel ${pause.channel}: a reassigned pause cannot be asked`);
  // an owner's pause with no channel: nobody is asked, the replacement just waits (#1307c)
  if (channel.sender === undefined) return markedSent(parts, pause);
  const own = ownDepsOf(deps, pause.workflow);
  const timeout = isApprovalPause(pause) ? own.tools(pause.ask.tool).timeout : DEFAULT_TOOL_TIMEOUT;
  const tree = await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId));
  const frame = pauseFrameOf(deps, pause, tree);
  const outcome = await callInFrame(
    { frame, timeout, clock, interruption: parts.interruption },
    () => sentBy(channel, askOfPause(pause), frame.execution.signal),
  );
  if (!isChannelOutcome(outcome))
    throw new TypeError(
      `channel ${channel.name}: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)`,
    );
  if (outcome.kind === ChannelOutcomeKind.Decided)
    return answeredAtOnce(parts, pause, channel.name, outcome.decision);
  await markedSent(parts, pause);
}

/** The replacement recorded as sent: asked of its channel, or of nobody (an owner's pause with no channel). */
async function markedSent(parts: ResendParts, pause: PauseRecord): Promise<void> {
  const { deps, pauses } = parts;
  await pauses.markSentByTenantIdAndPauseId(
    pause.tenantId,
    pause.pauseId,
    recipientsIn(deps.pause, pause),
  );
  noticesWritten(deps.pause);
  // asked: the replacement was unsent when this send began and the store marked it
  pauseTallyOf(deps.pause)?.opened(pause);
}

/**
 * A channel that decides at once for a replacement answers it (#946): through the normal answer path
 * — the decision validated, recorded by the store's compare-and-set, the tree moved under its
 * lease — as the channel itself (`answeredBy` its name; a thread owner's pause as its owner). A
 * re-send after a crash that decides again finds the pause answered: applied once.
 */
async function answeredAtOnce(
  parts: ResendParts,
  pause: PauseRecord,
  channel: string,
  decision: unknown,
): Promise<void> {
  await parts.decide(pause, decision, channel);
}

export type { ResendReassigned };
export { replacementSendsOf } from "./channel-decision.js";

/** One workflow's new send of a replacement (the re-send look's, #946). */
export const resendOf =
  (parts: Omit<ResendParts, "interruption">): ResendReassigned =>
  (pause, interruption) =>
    sendReplacement({ ...parts, interruption }, pause);

/** The pause open and not yet past its deadline, or why it is not. */
async function assertOpen(parts: ReassignParts, pause: PauseRecord): Promise<void> {
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
}

/**
 * `app.reassignPause` of one workflow's app. The store's one transaction decides: it applies only
 * while the pause is `Pending` and its deadline is after the instant of the write. A call that lost
 * it reads why (`PauseClosedError` with the reason of the close that won). The send after it is
 * told, never thrown: the reassignment is done, and the re-send look asks again.
 */
export const reassignPauseOf =
  (parts: ReassignParts): AnyTenantApp["reassignPause"] =>
  async (given, call: PauseCallerOptions = {}) => {
    parts.accepting();
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    checkedCallers("PauseCallerOptions", { ...call, tenantId });
    const request = checked(given);
    const pause = await pauseOf(parts.pauses, request, tenantId);
    await answeredByOf(parts, pause, call);
    await assertOpen(parts, pause);
    if (channelOf(parts.deps, pause) === undefined)
      reject([
        { path: ".pauseId", reason: "the pause's channel is no longer in this application" },
      ]);
    // the write is judged at this instant, after every read above (#1148)
    const at = parts.clock.now();
    const replacement = await parts.pauses.reassignByTenantIdAndPauseId(
      tenantId,
      pause.pauseId,
      { pauseId: newPauseId(), assignee: request.assignee },
      at,
      recipientsIn(parts.deps.pause, pause),
    );
    if (replacement === undefined) throw await pauseClosed(parts.pauses, pause, parts.clock.now());
    noticesWritten(parts.deps.pause);
    // counted once, by the call whose transaction won: the old pause closed `reassigned`
    pauseTallyOf(parts.deps.pause)?.closed(reassignedPause(pause, replacement.pauseId, at));
    pauseTallyOf(parts.deps.pause)?.reassigned(replacement);
    await sentAfter(parts, replacement);
    return { pauseKey: pauseKeyOf(tenantId, replacement.pauseId) };
  };

/** Asks the channel of the replacement; a failure is logged (never the id) and left to the re-send look. */
async function sentAfter(parts: ReassignParts, replacement: PauseRecord): Promise<void> {
  try {
    await sendReplacement(parts, replacement);
  } catch (error) {
    const text = `the new send of a reassigned pause of execution ${replacement.rootExecutionId} failed (${errorNamesOf(error)}); the re-send look asks again`;
    parts.deps.log.warn("pause.reassign-send-failed", text, {
      tenantId: replacement.tenantId,
      executionId: replacement.rootExecutionId,
    });
  }
}
