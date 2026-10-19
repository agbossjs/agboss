import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { UsageRecord } from "../../finops/usage.js";
import type { AgentAnswer } from "../../flow/runtime/answer-tools.js";
import type { HistoryTurn } from "../../flow/runtime/history.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { SensitiveValue } from "../../pii/policy-set.js";
import { mergeTokens, type PiiTokenMap } from "../../pii/tokens.js";

const append = <TItem>(left: readonly TItem[], right: readonly TItem[]): TItem[] => [
  ...left,
  ...right,
];
const replace = <TValue>(_previous: TValue, next: TValue): TValue => next;
const add = (left: number, right: number): number => left + right;
const merge = <TValue>(
  left: Readonly<Record<string, TValue>>,
  right: Readonly<Record<string, TValue>>,
): Record<string, TValue> => ({ ...left, ...right });

/** A finished tool call, stored under its call id: after a resume or a restart it is never run again. */
export interface StoredToolCall {
  readonly callId: string;
  readonly tool: string;
  /** What the model reads back: the tool's result, or `Tool error: …`. */
  readonly content: string;
}

/** An approver's decision on one call, before it ran. */
export interface CallDecision {
  readonly approved: boolean;
  readonly by: string;
  readonly reason?: string;
  readonly overrideArguments?: Record<string, unknown>;
}

/** How long the appended lists were when the flow handed the agent its work. */
export interface HandedOver {
  readonly usage: number;
  readonly approvals: number;
}

const NOTHING_HANDED_OVER: HandedOver = { usage: 0, approvals: 0 };

/**
 * The state of one agent's loop (its subgraph, #150): what the execution handed it — the run, its
 * spend so far, the thread's memory, its input message — plus the conversation with the
 * model, the move under way, finished calls and decisions by call id, the counters its limits check
 * and its answer. Checkpointed node by node — each tool call is its own task.
 */
export const AgentLoopState = Annotation.Root({
  runId: Annotation<string>({ reducer: replace, default: () => "" }),
  usage: Annotation<UsageRecord[]>({ reducer: append, default: () => [] }),
  approvals: Annotation<ApprovalRecord[]>({ reducer: append, default: () => [] }),
  history: Annotation<HistoryTurn[]>({ reducer: replace, default: () => [] }),
  summaries: Annotation<string[]>({ reducer: replace, default: () => [] }),
  /** The agent's input message (#270 Q51). */
  inputMessage: Annotation<string>({ reducer: replace, default: () => "" }),
  /** The flow nodes visited up to and including this agent (limit errors name it). */
  flowPath: Annotation<string[]>({ reducer: replace, default: () => [] }),
  /** Where this loop's additions start in the lists it was handed. */
  from: Annotation<HandedOver>({ reducer: replace, default: () => NOTHING_HANDED_OVER }),
  /** The conversation the model sees (the system prompt is added per call). */
  messages: Annotation<BaseMessage[]>({ reducer: append, default: () => [] }),
  /** The model's last move while its tool calls are judged, approved and run. */
  move: Annotation<AIMessage | null>({ reducer: replace, default: () => null }),
  results: Annotation<Record<string, StoredToolCall>>({ reducer: merge, default: () => ({}) }),
  decisions: Annotation<Record<string, CallDecision>>({ reducer: merge, default: () => ({}) }),
  modelCalls: Annotation<number>({ reducer: add, default: () => 0 }),
  toolCalls: Annotation<number>({ reducer: add, default: () => 0 }),
  /** The agent's reply as text (a text agent's answer; a structured answer's JSON); null while working. */
  reply: Annotation<string | null>({ reducer: replace, default: () => null }),
  /** A structured answer through an answer tool (S6); null for a text agent or while working. */
  answer: Annotation<AgentAnswer | null>({ reducer: replace, default: () => null }),
  /** Judge rejections retried so far. */
  retries: Annotation<number>({ reducer: add, default: () => 0 }),
  /** Invalid answers so far (S9: 2 retries, then `AgentAnswerInvalidError`). */
  invalidAnswers: Annotation<number>({ reducer: add, default: () => 0 }),
  /** The execution's PII tokens (#120 S38): handed in, every new one added by key. */
  piiTokens: Annotation<PiiTokenMap>({ reducer: mergeTokens, default: () => ({}) }),
  /** Texts this loop already masked for its model, by role and hash (`maskCacheKey`, #120). */
  piiMasked: Annotation<Readonly<Record<string, string>>>({ reducer: merge, default: () => ({}) }),
  /** The execution's sensitive context values (#120 AC13), masked wherever they appear. */
  piiValues: Annotation<readonly SensitiveValue[]>({ reducer: replace, default: () => [] }),
});

export type AgentLoopStateType = typeof AgentLoopState.State;
export type AgentLoopUpdate = typeof AgentLoopState.Update;

/** What this loop spent so far (not in the flow's state until the agent answers). */
export const loopUsage = (state: AgentLoopStateType): UsageRecord[] =>
  state.usage.slice(state.from.usage);

/** One tool call to run — the payload of its own task (`Send`). */
export interface ToolTask {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly runId: string;
}

export const LOOP_NODE = {
  input: "input",
  model: "model",
  boundary: "boundary",
  approval: "approval",
  tool: "tool",
  collect: "collect",
  reply: "agent-reply",
  answer: "agent-answer",
  judge: "judge",
} as const;
