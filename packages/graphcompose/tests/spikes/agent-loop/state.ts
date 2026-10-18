import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { CallDecision, JudgeRecord, StoredToolResult } from "./types.js";

const append = <TItem>(left: TItem[], right: TItem[]): TItem[] => left.concat(right);
const merge = <TValue>(
  left: Readonly<Record<string, TValue>>,
  right: Readonly<Record<string, TValue>>,
): Record<string, TValue> => ({ ...left, ...right });
const replace = <TValue>(_previous: TValue, next: TValue): TValue => next;

/** State of one agent step run as graph nodes (model → review → approval → tools → collect). */
export const LoopState = Annotation.Root({
  /** The conversation the model sees (system prompt added per call, not stored). */
  messages: Annotation<BaseMessage[]>({ reducer: append, default: () => [] }),
  /** The move under review: proposed by the model, not yet in `messages`. */
  move: Annotation<AIMessage | null>({ reducer: replace, default: () => null }),
  /** Finished tool calls by call id — checkpointed per call (one `Send` task each). */
  results: Annotation<Record<string, StoredToolResult>>({ reducer: merge, default: () => ({}) }),
  /** Calls stopped before running (judge reject, person rejected) or approved, by call id. */
  decisions: Annotation<Record<string, CallDecision>>({ reducer: merge, default: () => ({}) }),
  /** Revisions asked per `judge@point` in this step. */
  revisions: Annotation<Record<string, number>>({ reducer: merge, default: () => ({}) }),
  judgeLog: Annotation<JudgeRecord[]>({ reducer: append, default: () => [] }),
  /** The accepted final answer; null while the step is still working. */
  answer: Annotation<string | null>({ reducer: replace, default: () => null }),
});

export type LoopStateType = typeof LoopState.State;
export type LoopStateUpdate = typeof LoopState.Update;

/** Payload of one tool task (`Send`): the call and everything the tool node needs. */
export interface ToolTask {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
}

export const NODE = {
  model: "model",
  review: "review",
  approval: "approval",
  tool: "tool",
  collect: "collect",
} as const;

export type LoopNode = (typeof NODE)[keyof typeof NODE];
