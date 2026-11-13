import { interrupt } from "@langchain/langgraph";
import { AGBossError, type MessageErrorOptions } from "../../core/errors.js";
import type { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import type { ChannelSender } from "../../channels/channel-sender.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { UsageRecord } from "../../finops/usage.js";
import {
  decidedPause,
  logPauseAnswer,
  newPauseId,
  NO_RECIPIENTS,
  PauseResolution,
  PauseStatus,
  type PauseKind,
  type PauseAsk,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import type { PauseAnswerLog } from "../../infrastructure/pause-answer-log.js";
import { executionsFromRootOf, rootFactsOf, type FrameSpec } from "../context/frame.js";
import { idempotencyKeyOf } from "../context/idempotency.js";
import type { PauseWithdrawn } from "../../pause/index.js";
import { sentTooLate } from "./pause-late.js";
import { plainRecordOf, type ComponentRecord } from "./records.js";

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

/** A channel as a pause asks it: its sender and who may answer its pauses. */
export interface PauseChannel {
  readonly name: string;
  readonly sender: ChannelSender;
  readonly answerer: PauseAnswerer;
}

/**
 * What a step asks: whose tool call — or which question role's step (#659) — and the question
 * (`sensitive` fields masked).
 */
export interface PauseQuestion {
  /** What it waits for: the record's `kind`, written as is (0.1.1). */
  readonly kind: PauseKind;
  /** The step that asks: the agent of the tool call (or of a question tool, #712), or the question step. */
  readonly step: string;
  readonly ask: PauseAsk;
  /**
   * What asks, when it is not the step's own component: the question role an agent asks through
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
  ask: { readonly pauseId: string; readonly value: PauseAsk },
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

/** What a branch key is made from: a step of an execution. */
export interface BranchKeySite {
  readonly executionId: string;
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly itemIndex?: number | undefined;
}

/** A step's branch key (#337): `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}]`. */
export const branchKeyOf = (site: BranchKeySite): string =>
  idempotencyKeyOf({
    executionId: site.executionId,
    nodeId: site.nodeId,
    visitNumber: site.visitNumber,
    itemIndex: site.itemIndex,
  });

/** The keys of a waiting step and of every step that launched one of its executions (#337). */
function branchKeysAt(frame: FrameSpec): readonly string[] {
  const { execution, step } = frame;
  const launchers = executionsFromRootOf(execution).flatMap((each) =>
    each.parent === undefined
      ? []
      : [branchKeyOf({ ...each.parent.step, executionId: each.parent.execution.executionId })],
  );
  return [...launchers, branchKeyOf({ ...step, executionId: execution.executionId })];
}

/** The record a step would make: a new id, `Pending`, not sent. */
function newRecordOf(
  frame: FrameSpec,
  channel: PauseChannel,
  question: PauseQuestion,
  clock: Clock,
): PauseRecord {
  const { execution, step } = frame;
  return {
    pauseId: newPauseId(),
    tenantId: execution.tenant.tenantId,
    threadId: execution.threadId,
    // inside a child workflow (#263) the record belongs to the tree: its root, the child's own id
    rootExecutionId: rootFactsOf(execution).executionId,
    executionId: execution.executionId,
    workflow: execution.workflow.name,
    stepKey: step.idempotencyKey,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    // a per-item child's own index when its step has none (#263)
    itemIndex: step.itemIndex ?? execution.itemIndex,
    copyNumber: step.copyNumber,
    component: plainRecordOf(question.component ?? step.component),
    ...(step.toolLoopIteration === undefined ? {} : { toolLoopIteration: step.toolLoopIteration }),
    validationAttempts: step.validationAttempts,
    kind: question.kind,
    step: question.step,
    channel: channel.name,
    branchKeys: branchKeysAt(frame),
    answerer: channel.answerer,
    ask: question.ask,
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: clock.now().toISOString(),
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
  channel: string,
): Promise<StepAnswer> {
  const { answer } = pause;
  if (pause.status === PauseStatus.Cancelled || answer === undefined) {
    throw new PauseWithdrawnError({
      message: `pause ${pause.pauseId} was withdrawn: its branch was cancelled`,
    });
  }
  if (pause.status === PauseStatus.Resolved) {
    // a pass that is stopped runs nothing: its tool never acts, so the answer is not taken
    site.signal?.throwIfAborted();
    await site.pauses.markTakenByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
  }
  // a re-entry of a step its channel decided at once: the channel's decision, its spend counted already
  if (pause.resolution === PauseResolution.Decided)
    return { decision: answer.decision, by: channel, usage: [] };
  const by = answer.answeredBy ?? THREAD_OWNER;
  return { decision: answer.decision, by, usage: answer.usage ?? [] };
}

/** Where a pause step goes: the store, the channel, the step's frame and its signal. */
export interface PauseStepSite {
  readonly pauses: PausedExecutionRepository;
  /** The execution records: a pause its channel decided at once is logged there (#267 S107). */
  readonly answers: PauseAnswerLog;
  readonly channel: PauseChannel;
  readonly frame: FrameSpec;
  readonly signal: AbortSignal | undefined;
  /** The application's clock: when the pause was asked and decided. */
  readonly clock: Clock;
  /** Validates a decision the channel gave at once (as a reply would be), before it is recorded. */
  readonly validate: (decision: unknown) => unknown;
  /** Reported once, before the channel is asked (`onChannelStart`). */
  readonly onSend: () => Promise<void>;
  /** Tells the channel its pause closed while `send` was returning (#337). */
  readonly withdrawn?: PauseWithdrawn | undefined;
}

/** Asks the step's question through its pause: the answer, or the step stops at `interrupt()`. */
export async function pauseStep(site: PauseStepSite, question: PauseQuestion): Promise<StepAnswer> {
  const { pauses, channel, frame } = site;
  const { tenantId } = frame.execution.tenant;
  const made = newRecordOf(frame, channel, question, site.clock);
  let pause = await pauses.findOrCreateByStepKey(made);
  if (pause.status !== PauseStatus.Pending) return settledAnswer(site, pause, channel.name);
  site.signal?.throwIfAborted();
  if (!pause.isSent) {
    await site.onSend();
    const decided = await sendOnce(channel, pause, site.signal);
    if (decided !== undefined) {
      const decision = site.validate(decided.decision);
      const answer = { decision, answeredBy: undefined };
      const at = site.clock.now();
      if (await pauses.decideByTenantIdAndPauseId(tenantId, pause.pauseId, answer, at))
        await logPauseAnswer(
          site.answers,
          decidedPause(pause, answer, at),
          PauseResolution.Decided,
        );
      return { decision, by: channel.name, usage: [] };
    }
    if (!(await pauses.markSentByTenantIdAndPauseId(tenantId, pause.pauseId, NO_RECIPIENTS))) {
      // a reply resolved it while `send` was still returning: the step goes on with it
      pause = (await pauses.findByTenantIdAndPauseId(tenantId, pause.pauseId)) ?? pause;
      await sentTooLate(site, pause);
      return settledAnswer(site, pause, channel.name);
    }
  }
  site.signal?.throwIfAborted();
  interrupt<PauseInterruptValue, unknown>({ pauseId: pause.pauseId });
  // a resume answers a pause through its record, never through the interrupt's value
  throw new TypeError(`pause ${pause.pauseId} was resumed without a recorded decision`);
}
