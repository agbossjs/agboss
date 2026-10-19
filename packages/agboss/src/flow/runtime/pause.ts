import { interrupt } from "@langchain/langgraph";
import { AGBossError } from "../../core/errors.js";
import type { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import type { ChannelSender } from "../../channels/channel-sender.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { ToolCallApprovalAskDto } from "../../dto/standard/framework.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import { newPauseId, PauseStatus, type PauseRecord } from "../../infrastructure/pause-record.js";
import type { FrameSpec } from "../context/frame.js";

/**
 * The pause step (#267 S35): a waiting tool call is recorded by its step's idempotency key before
 * its channel is asked, so a re-entry finds the same `pauseId`. A new record is `Pending`, not
 * sent; the channel is asked once (`send`), then the record is marked sent — only while still
 * `Pending`, so a reply that resolved it during `send` is never overwritten — and the step stops
 * at LangGraph's `interrupt()`. A re-entry of a sent pause goes straight to `interrupt()`; a
 * `Resolved` one gives its decision at once; `ChannelOutcome.decided(…)` forgets the record (no
 * pause). The interrupt's value is the pause's id: a resume maps LangGraph's interrupt ids to the
 * pauses it answered (`resume-map.ts`).
 */

/** A channel as a pause asks it: its sender and who may answer its pauses. */
export interface PauseChannel {
  readonly name: string;
  readonly sender: ChannelSender;
  readonly answeredBy: PauseAnswerer;
}

/** What a step asks: whose tool call, and the question (`sensitive` fields masked). */
export interface PauseQuestion {
  readonly agent: string;
  readonly ask: ToolCallApprovalAskDto;
}

/** The answer a pause gives its step: the decision (validated by the caller) and who gave it. */
export interface PauseAnswer {
  readonly decision: unknown;
  /** Who answered: the resume's `answeredBy` or owner, or the channel that decided at once. */
  readonly by: string;
}

/** What the interrupt of a pause carries: its id only (the record has the rest). */
export interface PauseInterruptValue {
  readonly pauseId: string;
}

/** A pause that was withdrawn before its answer (its branch cancelled, #267 AC10). */
export class PauseWithdrawnError extends AGBossError {
  static override readonly code: string = "pause.withdrawn";
  override name = "PauseWithdrawnError";
}

/**
 * A channel's `send` threw (not cancelled): the failure of the step that asked, never a tool error
 * the model reads. Internal — the agent loop rethrows it as its `AgentFailedError`, the channel's
 * error as `cause`, so `.onError` / `.onJoinError` match it by class and cause chain (#273 S21).
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
  ask: { readonly pauseId: string; readonly value: ToolCallApprovalAskDto },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await channel.sender.send(ask);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ChannelSendError(channel.name, error);
  }
}

/** Who answered a thread owner's pause on an unowned thread (or a loop run on its own). */
export const THREAD_OWNER = "the thread's owner";

/** The record a step would make: a new id, `Pending`, not sent. */
function newRecordOf(
  frame: FrameSpec,
  channel: PauseChannel,
  question: PauseQuestion,
): PauseRecord {
  const { execution, step } = frame;
  return {
    pauseId: newPauseId(),
    tenantId: execution.tenant.tenantId,
    threadId: execution.threadId,
    rootExecutionId: execution.executionId,
    executionId: execution.executionId,
    workflow: execution.workflow.name,
    stepKey: step.idempotencyKey,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    itemIndex: step.itemIndex,
    agent: question.agent,
    channel: channel.name,
    answeredBy: channel.answeredBy,
    ask: question.ask,
    status: PauseStatus.Pending,
    isSent: false,
  };
}

/** The channel's outcome: the decision it gave now, or `undefined` when the step waits for a reply. */
async function sendOnce(
  channel: PauseChannel,
  pause: PauseRecord,
  signal: AbortSignal | undefined,
): Promise<{ decision: unknown } | undefined> {
  const outcome = await sentBy(channel, { pauseId: pause.pauseId, value: pause.ask }, signal);
  if (!isChannelOutcome(outcome)) {
    throw new TypeError(
      `channel ${channel.name}: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)`,
    );
  }
  return outcome.kind === ChannelOutcomeKind.Decided ? { decision: outcome.decision } : undefined;
}

/** A pause that is no longer pending: its decision, or its withdrawal. */
function settledAnswer(pause: PauseRecord): PauseAnswer {
  if (pause.status === PauseStatus.Cancelled || pause.resolution === undefined) {
    throw new PauseWithdrawnError(`pause ${pause.pauseId} was withdrawn: its branch was cancelled`);
  }
  return { decision: pause.resolution.decision, by: pause.resolution.answerer ?? THREAD_OWNER };
}

/** Where a pause step goes: the store, the channel, the step's frame and its signal. */
export interface PauseStepSite {
  readonly pauses: PausedExecutionRepository;
  readonly channel: PauseChannel;
  readonly frame: FrameSpec;
  readonly signal: AbortSignal | undefined;
  /** Reported once, before the channel is asked (`onChannelStart`). */
  readonly onSend: () => Promise<void>;
}

/** Asks the step's question through its pause: the answer, or the step stops at `interrupt()`. */
export async function pauseStep(
  site: PauseStepSite,
  question: PauseQuestion,
): Promise<PauseAnswer> {
  const { pauses, channel, frame } = site;
  const { tenantId } = frame.execution.tenant;
  let pause = await pauses.findOrCreateByStepKey(newRecordOf(frame, channel, question));
  if (pause.status !== PauseStatus.Pending) return settledAnswer(pause);
  site.signal?.throwIfAborted();
  if (!pause.isSent) {
    await site.onSend();
    const decided = await sendOnce(channel, pause, site.signal);
    if (decided !== undefined) {
      await pauses.deleteByTenantIdAndPauseId(tenantId, pause.pauseId);
      return { decision: decided.decision, by: channel.name };
    }
    if (!(await pauses.markSentByTenantIdAndPauseId(tenantId, pause.pauseId))) {
      // a reply resolved it while `send` was still returning: the step goes on with it
      pause = (await pauses.findByTenantIdAndPauseId(tenantId, pause.pauseId)) ?? pause;
      return settledAnswer(pause);
    }
  }
  site.signal?.throwIfAborted();
  interrupt<PauseInterruptValue, unknown>({ pauseId: pause.pauseId });
  // a resume answers a pause through its record, never through the interrupt's value
  throw new TypeError(`pause ${pause.pauseId} was resumed without a recorded decision`);
}
