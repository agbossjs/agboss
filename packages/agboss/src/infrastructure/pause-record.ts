import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
import { CostSource, type UsageRecord } from "../finops/usage.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import { lazyLoad } from "./clock.js";
import type { PauseAnswerLog } from "./pause-answer-log.js";

/**
 * One pause of an execution tree as the application records it (#267 S35): made once per waiting
 * step — keyed by the step's idempotency key — before its channel is asked, so a retried `send`
 * and a re-entry after a sibling's answer find the same `pauseId`.
 */

/** What bound a pause's deadline: its own `expiresIn`, the run's deadline, or a quorum's. */
export enum PauseExpiryBound {
  Pause = "pause",
  RunDeadline = "run-deadline",
  Quorum = "quorum",
}

/** Why an expiry decision fell back to failing the step (#941). */
export enum ExpiryProblem {
  HandlerFailed = "handler-failed",
  HandlerTimeout = "handler-timeout",
  AnswerInvalid = "answer-invalid",
}

/** Why a pause closed, as an error or a notice names it; derived by `pauseClosedReasonOf`. */
export enum PauseClosedReason {
  Answered = "answered",
  Expired = "expired",
  Cancelled = "cancelled",
  Withdrawn = "withdrawn",
  TreeEnded = "tree-ended",
  Reassigned = "reassigned",
}

/** Who hears of a pause's changes: the channel it asked (when it listens) and the listeners. */
export interface PauseRecipients {
  /** The channel's name; set only when its channel overrides at least one hook (#940). */
  readonly channel?: string;
  /** Every listener's name (kebab-case). */
  readonly listeners: readonly string[];
}

/** No one: a transition that tells nobody — what a call that predates notices passes. */
export const NO_RECIPIENTS: PauseRecipients = { listeners: [] };

/**
 * A pause as a metric, a log or an error names it where its id may not appear (I14): the first 128
 * bits of the SHA-256 of the tenant, a NUL and the pause id, in hex — one-way, so it answers nothing.
 * Neither part can hold a NUL (the key-text rules).
 */
export const pauseKeyOf = (tenantId: string, pauseId: string): string =>
  createHash("sha256").update(`${tenantId}\0${pauseId}`).digest("hex").slice(0, 32);

/** Where a pause is (#265, Q58; #267 AC10). */
export enum PauseStatus {
  /** Waiting for its decision. */
  Pending = "pending",
  /** A resume recorded its decision; the tree's lease holder continues it. */
  Resolved = "resolved",
  /**
   * Its step took the decision and went on (or its channel decided at once): kept for
   * `retention.pauseRecords`, so a late second answer gets `NotPausedError`.
   */
  Taken = "taken",
  /** Dropped: withdrawn (a `FailFast` sibling failed, a quorum was decided) or cancelled. */
  Cancelled = "cancelled",
}

/** How a pause was resolved (#267 S107): the audit trail of `ExecutionRecord.pauses`. */
export enum PauseResolution {
  /** Its channel decided at once (`ChannelOutcome.decided`): the step never paused. */
  Decided = "decided",
  /** Its channel awaited a reply (`awaitReply()`) and `app.resume` answered it. */
  Replied = "replied",
  /** A `FailFast` sibling failed, or its launch's quorum was decided, before an answer. */
  Withdrawn = "withdrawn",
  /** `app.cancel` before an answer. */
  Cancelled = "cancelled",
  /** Its tree finished or failed before an answer was taken (#910). */
  TreeEnded = "tree-ended",
  /** Its deadline passed with no answer: the step fails, or a run deadline or a quorum bound it. */
  Expired = "expired",
  /** Its deadline passed and its channel decided the answer. */
  DecidedOnExpiry = "decided-on-expiry",
  /** Moved to a new pause (#946; the value is reserved here). */
  Reassigned = "reassigned",
}

/** The ways a pause closes without an answer by a cancel: what `cancel…` takes. */
export type PauseCancellation =
  PauseResolution.Withdrawn | PauseResolution.Cancelled | PauseResolution.TreeEnded;

/** What a resolved pause whose answer no step took is closed as. */
export type PauseUntakenResolution = PauseResolution.Cancelled | PauseResolution.TreeEnded;

/** How an expiry closes a pause: with the channel's answer, or without; why it fell back to fail. */
export interface PauseExpiry {
  readonly answer?: PauseAnswer;
  readonly problem?: ExpiryProblem;
}

/** What answered a pause: the validated decision, who gave it, and what reading a reply cost. */
export interface PauseAnswer {
  readonly decision: unknown;
  /**
   * Who answered: the `answeredBy` of a `PauseAnswerer.Channel` pause's resume, the `ownerId` of a
   * `PauseAnswerer.ThreadOwner` one (`undefined` for a thread without an owner, or a channel that
   * decided at once). 0.1.0 named it `answerer`: a record stored then reads with the new name.
   */
  readonly answeredBy: string | undefined;
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
  /**
   * The launch branches it waits under (#337): the key of its own step and of every step that
   * launched one of its executions — `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}]` — so a
   * decided quorum or a `FailFast` failure finds it inside a child too; absent before #337.
   */
  readonly branchKeys?: readonly string[];
}

/** What a pause waits for and what a question asks (0.1.1: stored on every pause record). */

/** What a pause waits for (#659): a tool call's approval, or a question role's answer. */
export enum PauseKind {
  /** An agent's tool call through its channel: `ask` is the call, the answer a `ToolCallApprovalDecisionDto`. */
  Approval = "approval",
  /** A question role's step or tool (#659, #712): `ask` is the role's ask, the answer its `answer` DTO. */
  Question = "question",
}

declare const questionAsk: unique symbol;

/**
 * What a question role asks (#659): the role's `ask` value, `sensitive` fields masked — the
 * project's own DTO, so opaque here: a field of a `PendingPause`'s ask is read only after narrowing
 * on `kind` (an approval's ask keeps its typing), and a question's is read by assigning it to
 * `Readonly<Record<string, unknown>>` (0.1.1 API review). A plain object is not one.
 */
export type QuestionAsk = Readonly<{ [questionAsk]: true }>;

/**
 * A question's ask as the framework made it — the role's DTO, masked — or as a store of your own
 * reads it back (a question pause's `ask`, kept as written): the one place it is branded. Anything
 * but an object (`null`, an array, a text) throws `TypeError`.
 */
export function questionAskOf(ask: unknown): QuestionAsk {
  if (typeof ask !== "object" || ask === null || Array.isArray(ask))
    throw new TypeError(
      `a question's ask is an object (the role's ask DTO), not ${JSON.stringify(ask)}`,
    );
  return ask as QuestionAsk;
}

/** What a pause asks: a tool call to approve, or a question role's ask (#659). */
export type PauseAsk = ToolCallApprovalAskDto | QuestionAsk;

/** How and when a pause first closed with an answer: what a later untaken close keeps (#935). */
export interface PauseFirstClose {
  /** `Replied`, or `DecidedOnExpiry` when an expiry decided it. */
  readonly resolution: PauseResolution;
  /** When it closed (ISO 8601): the answer's time, or the time an expiry decided it. */
  readonly resolvedAt: string;
}

/** A pause: its id, where it waits, what it asks and where it is. */
export interface PauseRecord extends PauseSite {
  /** A random 128-bit token (hex), made once per pause: the right to answer it (AC3). */
  readonly pauseId: string;
  /**
   * What it waits for (0.1.1: stored, written by the step that pauses): a tool call's approval or
   * a question role's answer — what `ask` is. A store keeps it as written, never infers it.
   */
  readonly kind: PauseKind;
  /**
   * The step that asks: the agent whose tool call waits (an agent asking a question role through
   * its tool, #712, too), or a question role's step (#659).
   */
  readonly step: string;
  /** The channel asked: a role's name or a concrete `@Channel`'s. */
  readonly channel: string;
  /** Who may answer it (its channel role's `answerer`). */
  readonly answerer: PauseAnswerer;
  /**
   * @deprecated 0.1.0's name of `answerer`, until 0.2 — and **never filled** from 0.1.1: a record
   * the core returns has no `answeredBy` (`undefined`), `answeredBy` means the person who answered
   * everywhere else (one meaning per name, #934), so it is not kept as a second spelling of the
   * kind. Read `answerer`. A store of yours may still write it: the core reads `answerer ?? answeredBy`.
   */
  readonly answeredBy?: PauseAnswerer;
  /**
   * The question, `sensitive` fields masked: the tool call an approval waits for, or a question
   * role's ask (#659) — told apart by `kind`.
   */
  readonly ask: PauseAsk;
  readonly status: PauseStatus;
  /** Whether its channel's `send` returned (`awaitReply`): a re-entry does not ask again. */
  readonly isSent: boolean;
  /** When it was made, before its channel was asked (ISO 8601, the application's `Clock`). */
  readonly askedAt: string;
  /** The answer, once `Resolved` (or decided at once). */
  readonly answer?: PauseAnswer;
  /** How it was resolved; `undefined` while `Pending`. */
  readonly resolution?: PauseResolution;
  /** When it was resolved (ISO 8601); a resolved record is kept `retention.pauseRecords` after it. */
  readonly resolvedAt?: string;
  /** Its deadline: ISO 8601, absolute, on the application's `Clock` (D9); absent: none. */
  readonly expiresAt?: string;
  /** Which of the three bounds set `expiresAt`. */
  readonly expiryBound?: PauseExpiryBound;
  /** When its reminder is due (ISO 8601); absent once reminded, or none. */
  readonly remindAt?: string;
  /** Why an expiry decision fell back to failing the step (#941). */
  readonly expiryProblem?: ExpiryProblem;
  /**
   * Set by `closeUntaken`, which overwrites `resolution` and `resolvedAt` with the untaken close:
   * how and when the answer first closed the pause (`Replied`, `DecidedOnExpiry`), so the reason and
   * time a channel is told never depend on when `markSent` runs. A store keeps it as written.
   */
  readonly closedFirst?: PauseFirstClose;
  /** The smaller of the run's and a quorum's deadline at creation: an extension never passes it (#942). */
  readonly boundAt?: string;
}

/**
 * A pause of a question role (#659, #712): its `kind` says, never its component. Any other value
 * than the two kinds — a store that does not keep `kind` — throws: never read as an approval.
 */
export function isQuestionPause(pause: Pick<PauseRecord, "kind" | "pauseId">): boolean {
  switch (pause.kind) {
    case PauseKind.Question:
      return true;
    case PauseKind.Approval:
      return false;
    default:
      throw new TypeError(
        `pause ${pause.pauseId}: kind ${String(pause.kind)} is no PauseKind — a pause store keeps PauseRecord.kind as written`,
      );
  }
}

/** A pause of an agent's tool call: its `ask` is the call (every pause before #659). */
export type ApprovalPauseRecord = PauseRecord & { readonly ask: ToolCallApprovalAskDto };

/** Whether a pause approves a tool call (not a question role's, #659). */
export const isApprovalPause = (pause: PauseRecord): pause is ApprovalPauseRecord =>
  !isQuestionPause(pause);

/** The tool call a pause waits on; `undefined` for a question (#659), which waits on none. */
export const callIdOfPause = (pause: PauseRecord): string | undefined =>
  isApprovalPause(pause) ? pause.ask.callId : undefined;

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

/** Writes how a pause was resolved into its tree's execution records (the log loads on first use). */
export const logPauseAnswer = async (
  log: PauseAnswerLog,
  pause: PauseRecord,
  resolution: PauseResolution,
): Promise<void> => {
  const { logPauseAnswer: write } = await lazyLoad(import("./pause-answer-log.js"));
  await write(log, pause, resolution);
};

/**
 * Who may answer a pause: its `answerer`, else the `answeredBy` of a record a store of yours wrote
 * the 0.1.0 way (the deprecated alias of `PauseRecord`).
 */
export function pauseAnswererOf(pause: {
  readonly answerer?: PauseAnswerer | undefined;
  readonly answeredBy?: PauseAnswerer | undefined;
}): PauseAnswerer {
  const answerer = pause.answerer ?? pause.answeredBy;
  if (answerer === undefined) throw new TypeError("a pause record names who may answer it");
  return answerer;
}

/** What reading a reply cost (#267 S107): the fields the ledger is written from, the rest as written. */
const StoredUsage = z.looseObject({
  caller: z.string(),
  model: z.string(),
  ...{ inputTokens: z.number(), outputTokens: z.number() },
  ...{ cacheReadTokens: z.number(), cacheWriteTokens: z.number() },
  costUsd: z.number(),
  costSource: z.enum(CostSource),
  servedBy: z.string().optional(),
});

/** The answer a pause keeps (#267 S107): the decision, who gave it — 0.1.0 called that `answerer` —, its cost. */
export const StoredAnswer = z
  .object({
    decision: z.unknown(),
    answerer: z.string().optional(),
    answeredBy: z.string().optional(),
    usage: z.array(StoredUsage).optional(),
  })
  .transform((stored): PauseAnswer => ({
    decision: stored.decision,
    answeredBy: stored.answeredBy ?? stored.answerer,
    ...(stored.usage === undefined ? {} : { usage: stored.usage }),
  }));
