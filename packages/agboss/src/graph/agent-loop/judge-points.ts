import type { ToolCallRequest } from "./deps.js";

/** Where in an agent's loop a judge looks. */
export enum JudgePoint {
  BeforeToolCall = "beforeToolCall",
  AfterToolCall = "afterToolCall",
  BeforeAgentAnswer = "beforeAgentAnswer",
  OnChannelDecision = "onChannelDecision",
}

/** Whose judges look: the tool's own run first, then the agent's. */
export enum JudgeOwner {
  Tool = "tool",
  Agent = "agent",
}

/** One visit of a judge point: where, whose judges, which agent, which call (none before the replyWith). */
export interface JudgeVisit {
  readonly point: JudgePoint;
  readonly owner: JudgeOwner;
  readonly agent: string;
  readonly call?: ToolCallRequest;
  readonly decision?: {
    approved: boolean;
    by?: string;
    reason?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overrideArguments?: any;
  };
}

/**
 * The extension points of the move boundary, visited in order: tool judges `beforeToolCall` → agent
 * judges `beforeToolCall` → approval → run → `afterToolCall` (tool, then agent); `beforeAgentAnswer`
 * before the replyWith leaves the loop. Empty here — the judges themselves come with #123.
 */
export type JudgePoints = (visit: JudgeVisit) => Promise<void>;

export const noJudges: JudgePoints = () => Promise.resolve();
