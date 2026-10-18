/**
 * Spike #114 — an own agent loop on LangGraph. Prototype only: never exported from `src/`.
 * Domain types of the loop: moves, judges and their verdicts, tools, the agent definition.
 */
import type { BaseMessage, AIMessageChunk } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";

/** Where in an agent's step a judge looks. */
export type JudgePoint = "beforeCall" | "afterCall" | "beforeAnswer";

/** One tool call the model proposed (not run yet). */
export interface ToolCallMove {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
}

/** A finished tool call with its result. */
export interface ToolResultMove {
  readonly kind: "tool-result";
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly result: string;
}

/** The model's final answer (a move without tool calls). */
export interface AnswerMove {
  readonly kind: "answer";
  readonly text: string;
}

export interface AcceptVerdict {
  readonly kind: "accept";
}
export interface ReviseVerdict {
  readonly kind: "revise";
  readonly remark: string;
}
export interface RejectVerdict {
  readonly kind: "reject";
  readonly reason: string;
}

/** Before a call all three verdicts make sense. */
export type CallVerdict = AcceptVerdict | ReviseVerdict | RejectVerdict;
/** After a call and before the answer there is nothing to "not call": accept or revise only. */
export type ReviewVerdict = AcceptVerdict | ReviseVerdict;

/** A judge knows nothing about who uses it: a name, a revision limit and a decision. */
export interface Judge<TMove, TVerdict> {
  readonly name: string;
  readonly maxRevisions: number;
  judge(move: TMove): Promise<TVerdict>;
}

export type CallJudge = Judge<ToolCallMove, CallVerdict>;
export type ResultJudge = Judge<ToolResultMove, ReviewVerdict>;
export type AnswerJudge = Judge<AnswerMove, ReviewVerdict>;

/** An agent-owned judge scoped to one of its tools (`judge(X).beforeCall(WriteFileTool)`). */
export interface ScopedJudge<TJudge> {
  readonly tool: string;
  readonly judge: TJudge;
}

/** What a tool execution produced; failures are recoverable — the model sees them. */
export type ToolOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly code: string; readonly text: string };

/** A tool as the loop sees it: arguments are validated inside `execute`. */
export interface LoopTool {
  readonly name: string;
  readonly needsApproval: boolean;
  readonly beforeCall: readonly CallJudge[];
  readonly afterCall: readonly ResultJudge[];
  execute(args: unknown, signal: AbortSignal | undefined): Promise<ToolOutcome>;
}

/** The chat model for the next move, chosen by the conversation so far (scripts key on it). */
export type MoveModel = (
  conversation: readonly BaseMessage[],
) => Runnable<BaseMessage[], AIMessageChunk>;

export interface AgentJudges {
  readonly beforeCall: readonly ScopedJudge<CallJudge>[];
  readonly afterCall: readonly ScopedJudge<ResultJudge>[];
  readonly beforeAnswer: readonly AnswerJudge[];
}

/** Everything the loop needs for one agent. */
export interface LoopAgent {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model: MoveModel;
  readonly tools: readonly LoopTool[];
  readonly judges: AgentJudges;
  /** All revisions any judge may ask for in one agent step. */
  readonly maxRevisionsPerStep: number;
}

/** How a tool call ended: stored per call id, so a finished call is never run again. */
export interface StoredToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly outcome: ToolOutcome;
}

/** A decision taken on a call before it ran: by a judge (reject) or a person (approval). */
export interface CallDecision {
  readonly callId: string;
  readonly allowed: boolean;
  readonly by: string;
  readonly reason: string;
}

/** A judge's verdict as recorded in the run (observations, #126). */
export interface JudgeRecord {
  readonly judge: string;
  readonly point: JudgePoint;
  readonly verdict: CallVerdict["kind"];
  readonly note: string;
  /** The verdict asked for a revision but the limit was reached: the move went through. */
  readonly exhausted: boolean;
}

/** The question a paused run asks: approve one tool call. */
export interface ApprovalQuestion {
  readonly kind: "tool-approval";
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
}

/** The answer `resume` brings back. */
export interface ApprovalAnswer {
  readonly approved: boolean;
  readonly by: string;
  readonly note?: string;
}
