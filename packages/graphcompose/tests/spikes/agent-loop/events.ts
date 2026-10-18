import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { NODE, type LoopNode } from "./state.js";
import type { ApprovalQuestion } from "./types.js";

/** What `app.stream(...)` yields. Terminal events: done / paused / failed / cancelled. */
export type RunEvent =
  | { readonly kind: "node-started"; readonly node: LoopNode; readonly taskId: string }
  | { readonly kind: "node-finished"; readonly node: LoopNode; readonly taskId: string }
  | { readonly kind: "token"; readonly node: string; readonly text: string }
  | {
      readonly kind: "tool-called";
      readonly callId: string;
      readonly tool: string;
      readonly args: unknown;
    }
  | { readonly kind: "paused"; readonly question: ApprovalQuestion }
  | { readonly kind: "done"; readonly answer: string }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "cancelled" };

export type RunResult = Extract<RunEvent, { kind: "done" | "paused" | "failed" | "cancelled" }>;

export const isTerminal = (event: RunEvent): event is RunResult =>
  event.kind === "done" ||
  event.kind === "paused" ||
  event.kind === "failed" ||
  event.kind === "cancelled";

const NODES: ReadonlySet<string> = new Set(Object.values(NODE));
const isLoopNode = (name: string): name is LoopNode => NODES.has(name);

const TaskChunk = z.object({ id: z.string(), name: z.string() }).loose();
const ToolCalled = z.object({
  kind: z.literal("tool-called"),
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
});
const MessageMetadata = z.object({ langgraph_node: z.string() }).loose();

/** `tasks` mode: a task with `input` has started, one with `result` has finished. */
export function taskEvents(payload: unknown): RunEvent[] {
  const task = TaskChunk.safeParse(payload);
  if (!task.success || !isLoopNode(task.data.name)) return [];
  const kind = "result" in task.data ? "node-finished" : "node-started";
  return [{ kind, node: task.data.name, taskId: task.data.id }];
}

/** `messages` mode: model tokens, with the node that produced them. */
export function tokenEvents(message: BaseMessage, metadata: unknown): RunEvent[] {
  if (!AIMessageChunk.isInstance(message) || message.text === "") return [];
  const meta = MessageMetadata.safeParse(metadata);
  return [
    { kind: "token", node: meta.success ? meta.data.langgraph_node : "", text: message.text },
  ];
}

/** `custom` mode: what nodes wrote with `config.writer`. */
export function customEvents(payload: unknown): RunEvent[] {
  const called = ToolCalled.safeParse(payload);
  return called.success ? [called.data] : [];
}

export const QuestionSchema = z.object({
  kind: z.literal("tool-approval"),
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
});
