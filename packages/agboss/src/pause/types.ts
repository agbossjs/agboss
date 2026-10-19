import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";

/**
 * The pause seam: what an execution pauses on (#267 S35) — the checkpointer LangGraph's
 * `interrupt()` saves the waiting step in, and the application's record of every pause (its
 * `pauseId`, whether its channel was asked, its decision).
 */
export interface PauseSeam {
  readonly checkpointer: BaseCheckpointSaver;
  readonly pauses: PausedExecutionRepository;
}

/**
 * One pause an execution waits for (`result.pending`, #267 AC1): where it waits and what it asks.
 * A pause is answered by its id — `app.resume({ pauseId, decision }, …)` — anywhere in the tree.
 */
export interface PendingPause {
  /**
   * The pause's id, what `app.resume` takes — only for a `PauseAnswerer.ThreadOwner` pause. A
   * `PauseAnswerer.Channel` pause's id is the right to answer it: only its channel has it (AC3).
   */
  readonly pauseId?: string;
  /** Who may answer it: the thread's owner, or whoever the channel's side authenticates. */
  readonly answeredBy: PauseAnswerer;
  /** The agent whose tool call waits. */
  readonly agent: string;
  /** The channel asked (a role's name, or a concrete `@Channel`'s). */
  readonly channel: string;
  /** The child execution it waits in (#263); `undefined` in the root. */
  readonly childExecutionId: string | undefined;
  /** The item of a per-item launch it waits in (no copy of the item: its index is enough). */
  readonly itemIndex: number | undefined;
  /** The question: the tool call waiting for an approval, `sensitive` fields masked. */
  readonly ask: ToolCallApprovalAskDto;
}

/** A pause as the framework keeps it while it waits: its id always (hidden from callers per AC3). */
export interface WaitingPause extends PendingPause {
  readonly pauseId: string;
}

/** The pause as a caller sees it: a `Channel` pause without its id (AC3). */
export function pendingPauseOf(waiting: WaitingPause, isShown: boolean): PendingPause {
  const { pauseId, ...rest } = waiting;
  return isShown ? { pauseId, ...rest } : rest;
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
