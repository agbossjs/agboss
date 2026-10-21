import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
import type { UsageRecord } from "../finops/usage.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { ExecutionRecordRepository } from "./execution-record.repository.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import { componentOfStored, StoredComponent } from "./stored-step.js";

/**
 * One pause of an execution tree as the application records it (#267 S35): made once per waiting
 * step — keyed by the step's idempotency key — before its channel is asked, so a retried `send`
 * and a re-entry after a sibling's answer find the same `pauseId`.
 */

/** Where a pause is (#265, Q58; #267 AC10). */
export enum PauseStatus {
  /** Waiting for its decision. */
  Pending = "pending",
  /** A resume recorded its decision; the tree's lease holder continues it. */
  Resolved = "resolved",
  /**
   * Its step took the decision and went on (or its channel decided at once): kept for
   * `pauseRecordRetention`, so a late second answer gets `NotPausedError`.
   */
  Taken = "taken",
  /** Dropped: withdrawn (a `FailFast` sibling failed) or cancelled; it takes no answer. */
  Cancelled = "cancelled",
}

/** How a pause was resolved (#267 S107): the audit trail of `ExecutionRecord.pauses`. */
export enum PauseResolution {
  /** Its channel decided at once (`ChannelOutcome.decided`): the step never paused. */
  Decided = "decided",
  /** Its channel awaited a reply (`awaitReply()`) and `app.resume` answered it. */
  Replied = "replied",
  /** A `FailFast` sibling failed: its branch was cancelled before an answer. */
  Withdrawn = "withdrawn",
  /** `app.cancel`, or its tree ended, before an answer. */
  Cancelled = "cancelled",
}

/** The two ways a pause closes without an answer. */
export type PauseCancellation = PauseResolution.Withdrawn | PauseResolution.Cancelled;

/** What answered a pause: the validated decision, who gave it, and what reading a reply cost. */
export interface PauseAnswer {
  readonly decision: unknown;
  /**
   * Who answered: the `answeredBy` of a `PauseAnswerer.Channel` pause's resume, the `ownerId` of a
   * `PauseAnswerer.ThreadOwner` one (`undefined` for a thread without an owner, or a channel that
   * decided at once).
   */
  readonly answerer: string | undefined;
  /**
   * The model calls of its reply interpreter (`app.resume({ pauseId, reply })`): already in the
   * ledger, added to the execution's spend when its step takes the answer.
   */
  readonly usage?: readonly UsageRecord[];
}

/** Where in the tree a pause waits: its execution, its step and the tree it belongs to. */
export interface PauseSite {
  readonly tenantId: string;
  readonly threadId: string;
  /** The root of its execution tree (the tree's lease and stores are keyed by it). */
  readonly rootExecutionId: string;
  /** The execution it waits in: the root's own id, or a child's (#263). */
  readonly executionId: string;
  /** The workflow of that execution (`@Workflow({ name })`). */
  readonly workflow: string;
  /** `step.idempotencyKey` of the waiting tool call: one pause per step key. */
  readonly stepKey: string;
  /** The step's node (`critic-agent#2` for a copy) and visit: a launch's branch is found by them. */
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly itemIndex: number | undefined;
  /** Which copy of a repeated agent waits (#273), from 1. */
  readonly copyNumber: number;
  /** The waiting agent with its join keys (#268 S93); absent on a pause stored before them. */
  readonly component?: ComponentRecord;
  /** The tool-loop iteration whose move asked (#268 S93); absent before it. */
  readonly toolLoopIteration?: number;
  /** The step's validation attempts when it asked (#268 S93); absent before it. */
  readonly validationAttempts?: number;
}

/** A pause: its id, where it waits, what it asks and where it is. */
export interface PauseRecord extends PauseSite {
  /** A random 128-bit token (hex), made once per pause: the right to answer it (AC3). */
  readonly pauseId: string;
  /** The agent whose tool call waits. */
  readonly agent: string;
  /** The channel asked: a role's name or a concrete `@Channel`'s. */
  readonly channel: string;
  /** Who may answer it (its channel role's `answeredBy`). */
  readonly answeredBy: PauseAnswerer;
  /** The question, `sensitive` fields masked. */
  readonly ask: ToolCallApprovalAskDto;
  readonly status: PauseStatus;
  /** Whether its channel's `send` returned (`awaitReply`): a re-entry does not ask again. */
  readonly isSent: boolean;
  /** When it was made, before its channel was asked (ISO 8601, the application's `Clock`). */
  readonly askedAt: string;
  /** The answer, once `Resolved` (or decided at once). */
  readonly answer?: PauseAnswer;
  /** How it was resolved; `undefined` while `Pending`. */
  readonly resolution?: PauseResolution;
  /** When it was resolved (ISO 8601); a resolved record is kept `pauseRecordRetention` after it. */
  readonly resolvedAt?: string;
}

/** A pause's id: a cryptographically random 128-bit token, made once per pause (AC3). */
export const newPauseId = (): string => randomBytes(16).toString("hex");

/** The pause answered by `app.resume`: `Resolved` with its answer, `Replied`. */
export const resolvedPause = (pause: PauseRecord, answer: PauseAnswer, at: Date): PauseRecord => ({
  ...pause,
  status: PauseStatus.Resolved,
  answer,
  resolution: PauseResolution.Replied,
  resolvedAt: at.toISOString(),
});

/** The pause its channel decided at once: `Taken` with the channel's decision, `Decided`. */
export const decidedPause = (pause: PauseRecord, answer: PauseAnswer, at: Date): PauseRecord => ({
  ...pause,
  status: PauseStatus.Taken,
  answer,
  resolution: PauseResolution.Decided,
  resolvedAt: at.toISOString(),
});

/** The pause closed without an answer: `Cancelled`, withdrawn or cancelled. */
export const cancelledPause = (
  pause: PauseRecord,
  resolution: PauseCancellation,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution,
  resolvedAt: at.toISOString(),
});

/** Whether a resolved record's retention is over: `Taken` or `Cancelled`, resolved before `cutoff`. */
export const isExpiredPause = (pause: PauseRecord, cutoff: Date): boolean =>
  (pause.status === PauseStatus.Taken || pause.status === PauseStatus.Cancelled) &&
  pause.resolvedAt !== undefined &&
  pause.resolvedAt < cutoff.toISOString();

/**
 * Where a resolved pause is written (#267 S107): the execution records — the permanent history
 * behind `ExecutionRecord.pauses` — never the pause records, which the retention removes.
 */
export type PauseAnswerLog = Pick<
  ExecutionRecordRepository,
  "savePauseAnswer" | "findPauseAnswersByTenantIdAndRootExecutionId"
>;

/** Whether a pause was closed without an answer. */
const isWithoutAnswer = (resolution: PauseResolution): boolean =>
  resolution === PauseResolution.Withdrawn || resolution === PauseResolution.Cancelled;

/** A resolved pause as the execution record lists it (unmasked: the record is masked when read). */
export function answerRecordOf(pause: PauseRecord, resolution: PauseResolution): PauseAnswerRecord {
  const hasAnswer = !isWithoutAnswer(resolution);
  return {
    pauseId: pause.answeredBy === PauseAnswerer.Channel ? undefined : pause.pauseId,
    executionId: pause.executionId,
    step: {
      component: pause.component ?? bareRecordOf(pause.agent, ComponentKind.Agent),
      nodeId: pause.nodeId,
      visitNumber: pause.visitNumber,
      idempotencyKey: pause.stepKey,
      callId: pause.ask.callId,
      itemIndex: pause.itemIndex,
      copyNumber: pause.copyNumber,
      toolLoopIteration: pause.toolLoopIteration,
      validationAttempts: pause.validationAttempts ?? 0,
    },
    role: pause.channel,
    answeredBy: pause.answeredBy,
    responder: hasAnswer ? pause.answer?.answerer : undefined,
    resolution,
    askedAt: pause.askedAt,
    resolvedAt: pause.resolvedAt,
    decision: hasAnswer ? pause.answer?.decision : undefined,
  };
}

/** Writes how a pause was resolved into its tree's execution records. */
export const logPauseAnswer = (
  log: PauseAnswerLog,
  pause: PauseRecord,
  resolution: PauseResolution,
): Promise<void> =>
  log.savePauseAnswer(pause.tenantId, pause.rootExecutionId, answerRecordOf(pause, resolution));

const optionalText = z.string().optional();
const StoredPauseAnswer = z.object({
  pauseId: optionalText,
  executionId: z.string(),
  step: z.object({
    component: StoredComponent,
    nodeId: z.string(),
    visitNumber: z.number(),
    idempotencyKey: z.string(),
    callId: optionalText,
    itemIndex: z.number().optional(),
    copyNumber: z.number(),
    toolLoopIteration: z.number().optional(),
    validationAttempts: z.number().default(0),
  }),
  role: z.string(),
  answeredBy: z.enum(PauseAnswerer),
  responder: optionalText,
  resolution: z.enum(PauseResolution),
  askedAt: z.string(),
  resolvedAt: optionalText,
  decision: z.unknown().optional(),
});

/** A pause answer record as JSON stored it (`undefined` fields are left out by JSON: restored). */
export function pauseAnswerRecordOfJson(text: string): PauseAnswerRecord {
  const stored = StoredPauseAnswer.parse(JSON.parse(text));
  const { step } = stored;
  return {
    ...stored,
    pauseId: stored.pauseId,
    step: {
      ...step,
      component: componentOfStored(step.component),
      callId: step.callId,
      itemIndex: step.itemIndex,
      toolLoopIteration: step.toolLoopIteration,
    },
    responder: stored.responder,
    resolvedAt: stored.resolvedAt,
    decision: stored.decision,
  };
}
