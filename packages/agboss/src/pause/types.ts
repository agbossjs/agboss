import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type {
  PauseAnswerLog,
  PauseCancellation,
  PauseRecord,
  QuestionAsk,
} from "../infrastructure/pause-record.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import type { FrameSpec } from "../flow/context/frame.js";

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
  /** Tells a pause's channel it closed without an answer (#337); absent: nobody is told. */
  readonly withdrawn?: PauseWithdrawn;
}

/** What the tree of a withdrawn pause is, as the pass that withdrew it knows it (#337). */
export interface WithdrawalTree {
  readonly contexts: ExecutionContextValues;
  readonly ownerId: string | undefined;
  /** The version the execution that withdrew it started on. */
  readonly startedVersion: string;
}

/** A pause closed without an answer (#337): its record after the change, and why. */
export interface WithdrawnPause {
  readonly pause: PauseRecord;
  readonly resolution: PauseCancellation;
  /** The tree, when a pass withdrew it; read from the tree's checkpoint otherwise. */
  readonly tree?: WithdrawalTree;
  /** The pause's own frame, when its own step takes it back (`send` returned after it closed). */
  readonly frame?: FrameSpec;
}

/**
 * Tells the channel of a sent pause that it closed without an answer — once, by whoever closed it
 * (or by its own step); best-effort: it never throws.
 */
export type PauseWithdrawn = (withdrawn: WithdrawnPause) => Promise<void>;

/** What a pause waits for (#659): a tool call's approval, or a question role's answer. */
export enum PauseKind {
  /** An agent's tool call through its channel: `ask` is the call, the answer a `ToolCallApprovalDecisionDto`. */
  Approval = "approval",
  /** A question role's step (`.toQuestion(Role)`): `ask` is the role's ask, the answer its `answer` DTO. */
  Question = "question",
}

/** Where a pause waits and who answers it, whatever it asks. */
export interface PendingPauseSite {
  /**
   * The pause's id, what `app.resume` takes — only for a `PauseAnswerer.ThreadOwner` pause. A
   * `PauseAnswerer.Channel` pause's id is the right to answer it: only its channel has it (AC3).
   */
  readonly pauseId?: string;
  /** Who may answer it: the thread's owner, or whoever the channel's side authenticates. */
  readonly answeredBy: PauseAnswerer;
  /** The agent whose tool call waits, or the question role's step that asks (#659). */
  readonly agent: string;
  /** The channel asked (a role's name, or a concrete `@Channel`'s). */
  readonly channel: string;
  /** The child execution it waits in (#263); `undefined` in the root. */
  readonly childExecutionId: string | undefined;
  /** The item of a per-item launch it waits in (no copy of the item: its index is enough). */
  readonly itemIndex: number | undefined;
}

/** A tool call waiting for its approval. */
export interface PendingApproval extends PendingPauseSite {
  readonly kind: PauseKind.Approval;
  /** The question: the tool call waiting for an approval, `sensitive` fields masked. */
  readonly ask: ToolCallApprovalAskDto;
}

/** A question role's step waiting for its answer (#659). */
export interface PendingQuestion extends PendingPauseSite {
  readonly kind: PauseKind.Question;
  /** The question role's ask, `sensitive` fields masked. */
  readonly ask: QuestionAsk;
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
