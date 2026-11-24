import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { PauseToolCallSummary } from "../channels/pause-contexts.js";
import type { PauseAnswerLog } from "../infrastructure/pause-answer-log.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseTally } from "./pause-tally.js";
import {
  NO_RECIPIENTS,
  PauseKind,
  pauseInputOf,
  type PauseRecipients,
  type PauseRecord,
  type PauseTrailRecord,
} from "../infrastructure/pause-record.js";

/**
 * The pause seam: what an execution pauses on (#267 S35) — the checkpointer LangGraph's
 * `interrupt()` saves the waiting step in, and the application's record of every pause (its
 * `pauseId`, whether its channel was asked, its decision).
 */
export interface PauseSeam {
  readonly checkpointer: BaseCheckpointSaver;
  readonly pauses: PausedExecutionRepository;
  /** The execution records: how each pause was resolved is written there (#267 S107). */
  readonly answers: PauseAnswerLog;
  /** Who is told of a pause's changes, and the fast path of telling (#940); absent: nobody. */
  readonly notices?: PauseNotices;
}

/**
 * Who hears of a pause's change and when to look for it (#940): every transition call site asks
 * `recipientsOf` for the receivers it passes to the store — written in the transaction of the
 * change itself —, then calls `delivered()` right after the change returned, never after code that
 * may throw. The delivery itself is the application's (`app/pause-notice-delivery.ts`).
 */
export interface PauseNotices {
  /** Where the instance counts the changes it applies (#943); absent: nowhere. */
  readonly tally?: PauseTally | undefined;
  /** The pause's receivers: its channel when that listens to anything, and every listener. */
  readonly recipientsOf: (pause: PauseRecord) => PauseRecipients;
  /**
   * A transaction that wrote notices returned: this instance looks for them at once instead of at
   * its next tick. Not awaited; it never throws.
   */
  readonly delivered: () => void;
}

/** The receivers of a pause's change; nobody without the application's notices. */
export const recipientsIn = (
  seam: { readonly notices?: PauseNotices | undefined } | undefined,
  pause: PauseRecord,
): PauseRecipients => seam?.notices?.recipientsOf(pause) ?? NO_RECIPIENTS;

/** Tells the application a change that wrote notices returned (no-op without its notices). */
export const noticesWritten = (
  seam: { readonly notices?: PauseNotices | undefined } | undefined,
): void => {
  seam?.notices?.delivered();
};

export { PauseKind, pauseInputOf };

/** What every pending pause has, whatever it asks: where it waits and who answers it. */
export interface PendingPauseBase {
  /**
   * The pause's id, what `app.resume` takes — only for a `PauseAnswerer.ThreadOwner` pause. A
   * `PauseAnswerer.Channel` pause's id is the right to answer it: only its channel has it (AC3).
   */
  readonly pauseId?: string;
  /** Who may answer it: the thread's owner, or whoever the channel's side authenticates. */
  readonly answerer: PauseAnswerer;
  /**
   * The step that asks: the agent whose tool call waits (or that asks a question role through its
   * tool, #712), or a question role's step (#659).
   */
  readonly step: string;
  /** The channel asked (a role's name, or a concrete `@Channel`'s). */
  readonly channel: string;
  /**
   * What it asks, `sensitive` fields masked and PII tokenized: the arguments of the tool call an
   * approval waits for, or a question role's ask (#659) as `Readonly<Record<string, unknown>>`.
   */
  readonly input: Readonly<Record<string, unknown>>;
  /** Who it is for (a queue's members); absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** The id the channel's own system gave it (a ticket key); absent until the channel returned one. */
  readonly externalRef?: string;
  /** Its chain of custody, newest last: `opened`, then every reassignment. */
  readonly trail: readonly PauseTrailRecord[];
  /** The child execution it waits in (#263); `undefined` in the root. */
  readonly childExecutionId: string | undefined;
  /** The item of a per-item launch it waits in (no copy of the item: its index is enough). */
  readonly itemIndex: number | undefined;
  /**
   * When the pause expires (#941, ISO 8601, the application's clock): fixed when it was asked — the
   * smaller of its `expiresIn` and its run's deadline; absent: it waits without a deadline. An
   * answer at or after it is refused (`PauseClosedError`, reason `expired`).
   */
  readonly expiresAt?: string;
}

/** A tool call waiting for its approval. */
export interface PendingApproval extends PendingPauseBase {
  readonly kind: PauseKind.Approval;
  /** The tool call waiting for an approval: its id, the tool and a one-sentence summary. */
  readonly toolCall: PauseToolCallSummary;
}

/** A question role's step waiting for its answer (#659). */
export interface PendingQuestion extends PendingPauseBase {
  readonly kind: PauseKind.Question;
}

/**
 * One pause an execution waits for (`result.pending`, #267 AC1): where it waits and what it asks —
 * by `kind` (#659), a tool call's approval or a question role's answer. A pause is answered by its
 * id — `app.resume({ pauseId, decision }, …)` — anywhere in the tree.
 */
export type PendingPause = PendingApproval | PendingQuestion;

/** A pause as the framework keeps it while it waits: its id always (hidden from callers per AC3). */
export type WaitingPause = PendingPause & { readonly pauseId: string };

/** The pause as a caller sees it: a `Channel` pause without its id (AC3). */
export function pendingPauseOf(waiting: WaitingPause, isShown: boolean): PendingPause {
  const { pauseId, ...rest } = waiting;
  const hidden = rest as PendingPause;
  return isShown ? { ...hidden, pauseId } : hidden;
}

/** A tool call: which agent asked for which tool with which arguments. */
export interface AgentToolCall {
  readonly agent: string;
  readonly tool: string;
  readonly args: unknown;
}

/** A decided call: approved (with the tool's result) or rejected (with the decision's reason). */
export interface ApprovalRecord extends AgentToolCall {
  readonly approved: boolean;
  /**
   * Who or what decided: the `answeredBy` of a `Channel` pause's resume, the thread's owner, or the
   * channel that decided at once.
   */
  readonly by: string;
  readonly reason?: string;
  readonly overrideArguments?: Record<string, unknown>;
  readonly result?: string;
}
