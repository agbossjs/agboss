import { interrupt } from "@langchain/langgraph";
import { AGBossError, type MessageErrorOptions } from "../../core/errors.js";
import { keyTextRuleOf } from "../../core/key-text-rule.js";
import type { ChannelSenderSend } from "../../channels/channel-sender.js";
import type { PauseToolCallSummary } from "../../channels/pause-contexts.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { UsageRecord } from "../../finops/usage.js";
import {
  decidedPause,
  logPauseAnswer,
  PauseResolution,
  PauseStatus,
  type PauseKind,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import { DEFAULT_CHANNEL_TIMEOUT, type PauseChannel, type PauseTarget } from "./pause-channel.js";
import { callInFrame, NoticeTimeoutError, type NoticeCall } from "../../app/pause-notice-call.js";
import { PauseExpirySignal } from "./pause-expiry-failure.js";
import { askOfPause, assertSameQuestion, livePauseAfter } from "./pause-chain.js";
import { noticesWritten, recipientsIn } from "../../pause/index.js";
import { openedPause, type PauseStepSite } from "./pause-open.js";
import { markAsked } from "./pause-asked.js";
import { pauseTallyOf } from "../../pause/pause-tally.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import type { ComponentRecord } from "./records.js";

/**
 * The pause step (#267 S35): a waiting tool call is recorded by its step's idempotency key before
 * its channel is asked, so a re-entry finds the same `pauseId`. A new record is `Pending`, not
 * sent; the channel is asked once (`send`), then the record is marked sent — only while still
 * `Pending`, so a reply that resolved it during `send` is never overwritten — and the step stops
 * at LangGraph's `interrupt()`. A re-entry of a sent pause goes straight to `interrupt()`; a
 * `Resolved` one gives its decision at once; `ChannelOutcome.decided(…)` closes the record as
 * `Taken` / `PauseResolution.Decided` (no pause; kept for the audit trail, #267 S107). The interrupt's value is the pause's id: a resume maps LangGraph's interrupt ids to the
 * pauses it answered (`resume-map.ts`).
 */

/**
 * What a step asks: whose tool call — or which external task's step (#659) — and the question
 * (`sensitive` fields masked).
 */
export interface PauseQuestion {
  /** What it waits for: the record's `kind`, written as is (0.1.1). */
  readonly kind: PauseKind;
  /** The step that asks: the agent of the tool call (or of a question tool, #712), or the question step. */
  readonly step: string;
  /** What it asks, `sensitive` fields masked: the tool call's arguments, or the role's ask. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The tool call an approval waits on; none for a question. */
  readonly toolCall?: PauseToolCallSummary;
  /**
   * What asks, when it is not the step's own component: the external task an agent asks through
   * its tool loop (#712) — the record's `component`.
   */
  readonly component?: ComponentRecord;
}

/** The answer a pause gives its step: the decision (validated by the caller) and who gave it. */
export interface StepAnswer {
  readonly decision: unknown;
  /** Who answered: the resume's `answeredBy` or owner, or the channel that decided at once. */
  readonly by: string;
  /** What reading a free-text reply cost (its interpreter's calls): the step's spend from now on. */
  readonly usage: readonly UsageRecord[];
}

/** What the interrupt of a pause carries: its id only (the record has the rest). */
export interface PauseInterruptValue {
  readonly pauseId: string;
}

/** A pause that was withdrawn before its answer (its branch cancelled, #267 AC10). */
export class PauseWithdrawnError extends AGBossError {
  static override readonly code = "pause.withdrawn" as const;
  declare readonly code: typeof PauseWithdrawnError.code;
  override name = "PauseWithdrawnError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/**
 * A channel's `send` threw (not cancelled): the failure of the step that asked, never a tool error
 * the model reads. Internal — the agent loop rethrows it as its `StepError.Agent`, the channel's
 * error as `cause`, so `.onError` match it by class and cause chain (#273 S21).
 */
export class ChannelSendError extends Error {
  override name = "ChannelSendError";

  constructor(channel: string, cause: unknown) {
    super(`channel ${channel}: send() failed`, { cause });
  }
}

/** The channel asked once: its outcome, a failure (not a cancellation) as `ChannelSendError`. */
export async function sentBy(
  channel: Pick<PauseChannel, "name" | "sender">,
  ask: ChannelSenderSend,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const { sender } = channel;
  try {
    return await sender.send(ask);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ChannelSendError(channel.name, error);
  }
}

/** Who answered a thread owner's pause on an unowned thread (or a loop run on its own). */
export const THREAD_OWNER = "the thread's owner";

export type { PauseChannel, PauseTarget } from "./pause-channel.js";
export { branchKeyOf, type BranchKeySite } from "./pause-record-made.js";

/** The channel a pause was sent through, by the name its record keeps; `undefined`: none (an owner's pause). */
export const channelOfPause = (
  target: Pick<PauseTarget, "channels">,
  pause: Pick<PauseRecord, "channel">,
): PauseChannel | undefined => [...target.channels].find(([name]) => name === pause.channel)?.[1];

/** What a channel's `send` said: the decision it gave now, or that the step waits (with the pause's reference in its system). */
export type Sent = { readonly decision: unknown } | { readonly externalRef?: string | undefined };

/** The reference a channel gave its pause: a key's text, else `send` is refused — never a stored value nobody can read back. */
export function checkedExternalRef(channel: string, given: unknown): string | undefined {
  if (given === undefined) return undefined;
  if (typeof given !== "string" || keyTextRuleOf(given) !== undefined)
    throw new TypeError(`channel ${channel}: externalRef of awaitReply() is a key's text`);
  return given;
}

/** The channel's outcome: the decision it gave now, or what the step waits with (its `externalRef`). */
export async function sendOnce(
  channel: PauseChannel | undefined,
  pause: PauseRecord,
  signal: AbortSignal | undefined,
  within?: Omit<NoticeCall, "timeout">,
): Promise<Sent> {
  // an owner's pause with no channel asks nobody: it waits for the owner's resume (#1307c)
  if (channel === undefined) return {};
  const send = (): Promise<unknown> => sentBy(channel, askOfPause(pause), signal);
  const timeout = channel.timeout ?? DEFAULT_CHANNEL_TIMEOUT;
  const outcome = await (within === undefined
    ? send()
    : callInFrame({ ...within, timeout }, send).catch((error: unknown) => {
        // a send that ran out its timeout is the channel's failure, like any other of its throws
        throw error instanceof NoticeTimeoutError
          ? new ChannelSendError(channel.name, error)
          : error;
      }));
  if (!isChannelOutcome(outcome)) {
    throw new TypeError(
      `channel ${channel.name}: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)`,
    );
  }
  return outcome.kind === ChannelOutcomeKind.Decided
    ? { decision: outcome.decision }
    : { externalRef: checkedExternalRef(channel.name, outcome.externalRef) };
}

/** Whether its channel decided the pause's answer: at once, or when its deadline passed (#941). */
const isDecidedByChannel = ({ resolution }: PauseRecord): boolean =>
  resolution === PauseResolution.Decided || resolution === PauseResolution.DecidedOnExpiry;

/**
 * What a pause that closed without an answer is to its step: the expiry's signal when its deadline
 * passed (#941: the asking step fails), else its withdrawal.
 */
const withoutAnswer = (pause: PauseRecord): Error =>
  pause.resolution === PauseResolution.Expired
    ? new PauseExpirySignal(pause)
    : new PauseWithdrawnError({
        message: `pause ${pause.pauseId} was withdrawn: its branch was cancelled`,
      });

/**
 * A pause that is no longer pending, as its step takes it: its decision, or its withdrawal. A
 * `Resolved` answer is marked `Taken` here, durably, before the step acts on it (#939) — so a pass
 * that fails after its tool ran leaves the audit saying the answer was taken, and a tree end never
 * closes it not-taken. A recovery that finds a `Taken` pause whose interrupt still waits runs the
 * step again with that answer.
 */
async function settledAnswer(
  site: Pick<PauseStepSite, "pauses" | "signal">,
  pause: PauseRecord,
): Promise<StepAnswer> {
  const { answer } = pause;
  if (pause.status === PauseStatus.Cancelled || answer === undefined) throw withoutAnswer(pause);
  if (pause.status === PauseStatus.Resolved) {
    // a pass that is stopped runs nothing: its tool never acts, so the answer is not taken
    site.signal?.throwIfAborted();
    await site.pauses.markTakenByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
  }
  // a re-entry of a step its channel decided at once, or on the pause's expiry (#941): the
  // channel's decision, its spend counted already
  if (isDecidedByChannel(pause))
    return { decision: answer.decision, by: pause.channel ?? pause.target, usage: [] };
  const by = answer.actor?.id ?? THREAD_OWNER;
  return { decision: answer.decision, by, usage: answer.usage ?? [] };
}

/**
 * A pause the step's own write found no longer pending (`decide` or `markSent` refused it): its live
 * record — a moved pause's replacement — as the step takes it. The answer recorded meanwhile, or the
 * withdrawal or expiry, is honoured; a replacement still waiting stops the step at `interrupt()`
 * (`undefined`). Never what this pass's `send` returned: only a recorded answer is acted on.
 */
async function takenAfterLostWrite(
  site: PauseStepSite,
  pause: PauseRecord,
): Promise<StepAnswer | undefined> {
  const { tenantId } = site.frame.execution.tenant;
  const fresh = (await site.pauses.findByTenantIdAndPauseId(tenantId, pause.pauseId)) ?? pause;
  const live = await livePauseAfter(site.pauses, fresh);
  if (live.status === PauseStatus.Pending) {
    // the same pause, unmarked: this pass asked its channel, an expiry changed it in place meanwhile
    if (live.pauseId === pause.pauseId && !live.isSent) await markAsked(site, pause);
    return undefined;
  }
  return settledAnswer(site, live);
}

/**
 * The decision the channel gave at once: validated, recorded as `Decided`, logged — only when the
 * store's compare-and-set took it, over the pause as sent (`seenOf`). A pause answered, withdrawn,
 * moved or changed while `send` ran keeps that: the step takes it (`takenAfterLostWrite`).
 */
async function answeredAtOnce(
  site: PauseStepSite,
  pause: PauseRecord,
  given: unknown,
): Promise<StepAnswer | undefined> {
  const decision = site.validate(given);
  const answer = { decision, actor: undefined };
  const at = site.clock.now();
  const isDecided = await site.pauses.decideByTenantIdAndPauseId(
    site.frame.execution.tenant.tenantId,
    pause.pauseId,
    answer,
    at,
    seenOf(pause),
  );
  if (!isDecided) return takenAfterLostWrite(site, pause);
  await logPauseAnswer(site.answers, decidedPause(pause, answer, at), PauseResolution.Decided);
  return { decision, by: pause.channel ?? pause.target, usage: [] };
}

/**
 * Asks a pause's channel once and marks it sent: the answer a channel gave at once, the answer a
 * reply gave meanwhile, or `undefined` while the pause waits (the step then stops at `interrupt()`).
 */
async function sentOnce(site: PauseStepSite, pause: PauseRecord): Promise<StepAnswer | undefined> {
  const { pauses, target } = site;
  const { tenantId } = site.frame.execution.tenant;
  // a pause an expiry or an operator moved to another target's channel is asked by the re-send look, which
  // finds that channel; this step's own target does not have it — never mark it sent unasked
  if (pause.channel !== undefined && channelOfPause(target, pause) === undefined) return undefined;
  await site.onSend();
  const sent = await sendOnce(channelOfPause(target, pause), pause, site.signal, {
    frame: site.frame,
    clock: site.clock,
    interruption: site.signal,
  });
  if ("decision" in sent) return answeredAtOnce(site, pause, sent.decision);
  const recipients = recipientsIn(site, pause);
  const isPending = await pauses.markSentByTenantIdAndPauseId(
    tenantId,
    pause.pauseId,
    recipients,
    sent.externalRef,
  );
  // its notices are written: looked for at once — before `settledAnswer` and `interrupt()` throw
  noticesWritten(site);
  // asked: this pass saw `isSent` false and the store marked it (a re-entry never gets here)
  pauseTallyOf(site)?.opened(pause);
  if (isPending) return undefined;
  // a reply resolved it while `send` was still returning: the step goes on with it
  return takenAfterLostWrite(site, pause);
}

/** Asks the step's question through its pause: the answer, or the step stops at `interrupt()`. */
export async function pauseStep(site: PauseStepSite, question: PauseQuestion): Promise<StepAnswer> {
  const found = await openedPause(site, question);
  assertSameQuestion(found, question);
  const pause = await livePauseAfter(site.pauses, found);
  if (pause.status !== PauseStatus.Pending) return settledAnswer(site, pause);
  site.signal?.throwIfAborted();
  if (!pause.isSent) {
    const answer = await sentOnce(site, pause);
    if (answer !== undefined) return answer;
  }
  site.signal?.throwIfAborted();
  interrupt<PauseInterruptValue, unknown>({ pauseId: pause.pauseId });
  // a resume answers a pause through its record, never through the interrupt's value
  throw new TypeError(`pause ${pause.pauseId} was resumed without a recorded decision`);
}

export { ChannelSelectError, type PauseStepSite } from "./pause-open.js";
