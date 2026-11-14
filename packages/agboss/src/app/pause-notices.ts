import { createHash } from "node:crypto";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { ChannelOf } from "../channels/channel-handler.js";
import type { ChannelSender } from "../channels/channel-sender.js";
import {
  pauseAnswererOf,
  pauseKeyOf,
  PauseClosedReason,
  type PauseRecipients,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import type { PauseNotice } from "../infrastructure/pause-notices.js";
import type { ChannelSenderClosed, ChannelSenderNotTaken } from "../channels/channel-sender.js";
import type {
  PauseListenerAnswerNotTakenEvent,
  PauseListenerClosedEvent,
  PauseListenerEventBase,
  PauseListenerOpenedEvent,
} from "../pause/notice-events.js";

/**
 * Who hears of a pause's change and what each is told (#940): `recipientsOf` is what every
 * transition call site passes to the store, so the notices of #940 and the deadlines of #941
 * change one function and not the call sites; the events are built from the notice and the pause's
 * record when a notice is delivered.
 */

/** The notice hooks of a channel: it listens when its sender overrides any of them. */
const NOTICE_HOOKS = ["onPauseClosed", "onPauseAnswerNotTaken"] as const;

/** Whether a channel's sender has a hook of its own: a function, not `ChannelOf`'s default. */
export function hookOverridden(
  sender: ChannelSender,
  hook: (typeof NOTICE_HOOKS)[number],
): boolean {
  const own: unknown = Reflect.get(sender, hook);
  return typeof own === "function" && own !== Reflect.get(ChannelOf.prototype, hook);
}

/** Whether the channel listens to anything: a mailbox exists only for one that does (V11.4). */
export const listensTo = (sender: ChannelSender | undefined): boolean =>
  sender !== undefined && NOTICE_HOOKS.some((hook) => hookOverridden(sender, hook));

/** What `recipientsOf` is made of: the pause's channel, by its workflow, and the listeners' names. */
export interface RecipientSources {
  /** The pause's channel sender; `undefined` when its workflow's app has none of that name. */
  readonly senderOf: (pause: PauseRecord) => ChannelSender | undefined;
  /** Every listener's name (kebab-case), in the order listed. */
  readonly listeners: readonly string[];
}

/** The receivers of a pause's changes: its channel when it listens, and every listener. */
export const recipientsOf =
  (sources: RecipientSources) =>
  (pause: PauseRecord): PauseRecipients => {
    const channel = listensTo(sources.senderOf(pause)) ? { channel: pause.channel } : {};
    return { ...channel, listeners: sources.listeners };
  };

/** The idempotency key of one notice to one receiver: the same on every redelivery. */
export const deliveryIdOf = (pause: PauseRecord, recipient: string, notice: PauseNotice): string =>
  createHash("sha256")
    .update(`${pauseKeyOf(pause.tenantId, pause.pauseId)}:${recipient}:${String(notice.seq)}`)
    .digest("hex")
    .slice(0, 32);

/** What an event is made of beside the record: the notice, its id and the masking. */
export interface EventSources {
  readonly pause: PauseRecord;
  readonly notice: PauseNotice;
  readonly deliveryId: string;
  /** The observability mask (I15); the value as it is without one. */
  readonly masked: (value: unknown) => Promise<unknown>;
}

const untakenReasons = [PauseClosedReason.Cancelled, PauseClosedReason.TreeEnded] as const;

/** `reason` of a not-taken notice: always a cancel or a tree's end (the store writes no other). */
function untakenReasonOf(
  notice: PauseNotice,
): PauseClosedReason.Cancelled | PauseClosedReason.TreeEnded {
  const found = untakenReasons.find((reason) => reason === notice.reason);
  if (found === undefined)
    throw new TypeError(`an answer-not-taken notice names its reason: ${String(notice.reason)}`);
  return found;
}

/** Whether a close carries the answer: an answer, or an expiry's decision. */
const hasAnswer = (reason: PauseClosedReason, pause: PauseRecord): boolean =>
  pause.answer !== undefined &&
  (reason === PauseClosedReason.Answered || reason === PauseClosedReason.Expired);

/** The `closed` event of a channel: the question as `send` got it, the answer masked. */
export async function channelClosedOf(sources: EventSources): Promise<ChannelSenderClosed> {
  const { pause, notice, deliveryId } = sources;
  const reason = notice.reason ?? PauseClosedReason.Cancelled;
  const base = { deliveryId, pauseId: pause.pauseId, value: pause.ask, reason };
  const closedAt = notice.closedAt ?? notice.writtenAt;
  if (!hasAnswer(reason, pause)) return { ...base, closedAt };
  const answer = await sources.masked(pause.answer?.decision);
  const by = reason === PauseClosedReason.Answered ? pause.answer?.answeredBy : undefined;
  return { ...base, closedAt, ...(by === undefined ? {} : { answeredBy: by }), answer };
}

/** The `answerNotTaken` event of a channel. */
export async function channelNotTakenOf(sources: EventSources): Promise<ChannelSenderNotTaken> {
  const { pause, notice, deliveryId } = sources;
  const by = pause.answer?.answeredBy;
  return {
    deliveryId,
    pauseId: pause.pauseId,
    value: pause.ask,
    reason: untakenReasonOf(notice),
    at: notice.closedAt ?? notice.writtenAt,
    ...(by === undefined ? {} : { answeredBy: by }),
    answer: await sources.masked(pause.answer?.decision),
  };
}

/** What a listener reads of every pause: the safe context; the id only when it may answer. */
async function listenerBaseOf(
  sources: EventSources,
  allowAnswering: boolean,
): Promise<PauseListenerEventBase> {
  const { pause, notice, deliveryId } = sources;
  const showsId = allowAnswering || pauseAnswererOf(pause) === PauseAnswerer.ThreadOwner;
  const expiresAt = notice.expiresAt ?? pause.expiresAt;
  return {
    deliveryId,
    pauseKey: pauseKeyOf(pause.tenantId, pause.pauseId),
    ...(showsId ? { pauseId: pause.pauseId } : {}),
    tenantId: pause.tenantId,
    rootExecutionId: pause.rootExecutionId,
    executionId: pause.executionId,
    threadId: pause.threadId,
    workflow: pause.workflow,
    step: pause.step,
    kind: pause.kind,
    channel: pause.channel,
    answerer: pauseAnswererOf(pause),
    ask: await sources.masked(pause.ask),
    askedAt: pause.askedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** The `opened` event of a listener. */
export const listenerOpenedOf = (
  sources: EventSources,
  allowAnswering: boolean,
): Promise<PauseListenerOpenedEvent> => listenerBaseOf(sources, allowAnswering);

/** The `closed` event of a listener. */
export async function listenerClosedOf(
  sources: EventSources,
  allowAnswering: boolean,
): Promise<PauseListenerClosedEvent> {
  const { pause, notice } = sources;
  const reason = notice.reason ?? PauseClosedReason.Cancelled;
  const base = await listenerBaseOf(sources, allowAnswering);
  const closed = { ...base, reason, closedAt: notice.closedAt ?? notice.writtenAt };
  if (!hasAnswer(reason, pause)) return closed;
  const by = reason === PauseClosedReason.Answered ? pause.answer?.answeredBy : undefined;
  const answer = await sources.masked(pause.answer?.decision);
  return { ...closed, ...(by === undefined ? {} : { answeredBy: by }), answer };
}

/** The `answerNotTaken` event of a listener. */
export async function listenerNotTakenOf(
  sources: EventSources,
  allowAnswering: boolean,
): Promise<PauseListenerAnswerNotTakenEvent> {
  const { pause, notice } = sources;
  const by = pause.answer?.answeredBy;
  return {
    ...(await listenerBaseOf(sources, allowAnswering)),
    reason: untakenReasonOf(notice),
    at: notice.closedAt ?? notice.writtenAt,
    ...(by === undefined ? {} : { answeredBy: by }),
    answer: await sources.masked(pause.answer?.decision),
  };
}
