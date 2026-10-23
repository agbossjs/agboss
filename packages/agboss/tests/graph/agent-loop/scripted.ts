/** The agent loop's test script: moves picked by the conversation, and tools that log their effects. */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { z } from "zod";
import { defineTool, type AnyTool } from "../../../src/tools/index.js";

/** One tool call the script makes; without an id the loop assigns one. */
export interface ScriptedCall {
  readonly id?: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** One call whose arguments are no JSON (the provider's `invalid_tool_calls`, #395). */
export interface ScriptedUnreadCall {
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly error: string;
}

/** One model move: an replyWith, tool calls, or calls with unparsable arguments (beside read ones). */
export type ScriptedMove =
  | { readonly kind: "replyWith"; readonly text: string }
  | { readonly kind: "calls"; readonly calls: readonly ScriptedCall[] }
  | {
      readonly kind: "unread";
      readonly unread: readonly ScriptedUnreadCall[];
      readonly calls: readonly ScriptedCall[];
    };

export const replyWith = (text: string): ScriptedMove => ({ kind: "replyWith", text });
export const callTools = (...calls: ScriptedCall[]): ScriptedMove => ({ kind: "calls", calls });
/** A move with one truncated call (and, optionally, read ones beside it). */
export const callTruncated = (
  unread: ScriptedUnreadCall,
  ...calls: ScriptedCall[]
): ScriptedMove => ({ kind: "unread", unread: [unread], calls });
export const read = (id: string, path: string): ScriptedCall => ({
  id,
  name: "read-file-tool",
  args: { path },
});
export const write = (id: string, path: string, content = "x"): ScriptedCall => ({
  id,
  name: "write_file",
  args: { path, content },
});
export const wait = (id: string, ms: number): ScriptedCall => ({ id, name: "wait", args: { ms } });

const USAGE = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

const messageOf = (move: ScriptedMove): AIMessage =>
  move.kind === "replyWith"
    ? new AIMessage({ content: move.text, usage_metadata: USAGE })
    : new AIMessage({
        content: "",
        usage_metadata: USAGE,
        tool_calls: move.calls.map((call) => ({ ...call, type: "tool_call" as const })),
        ...(move.kind === "unread"
          ? {
              invalid_tool_calls: move.unread.map((call) => ({
                ...call,
                type: "invalid_tool_call" as const,
              })),
            }
          : {}),
      });

/**
 * Picks the move by the conversation — how many moves the model made so far — never by call order,
 * so a process that resumes a run continues the same script.
 */
export class ConversationModel extends BaseChatModel {
  readonly sent: BaseMessage[][] = [];

  constructor(
    private readonly moves: readonly ScriptedMove[],
    private readonly onCall: (move: number) => void = () => undefined,
  ) {
    super({});
  }

  _llmType(): string {
    return "conversation-scripted";
  }

  override bindTools(): this {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const index = messages.filter((message) => AIMessage.isInstance(message)).length;
    this.sent.push(messages);
    this.onCall(index);
    const move = this.moves[index];
    if (move === undefined) return Promise.reject(new Error(`no scripted move #${String(index)}`));
    const message = messageOf(move);
    return Promise.resolve({ generations: [{ text: message.text, message }] });
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });

/** read-file-tool, write_file (a write: needs approval), wait (slow, for order checks), boom (throws). */
export function repoTools(log: (effect: string) => void): AnyTool[] {
  return [
    defineTool({
      name: "read-file-tool",
      description: "Read a file",
      input: z.object({ path: z.string() }),
      output: z.string(),
      run: ({ path }) => {
        log(`read ${path}`);
        return Promise.resolve(`contents of ${path}`);
      },
    }),
    defineTool({
      name: "write_file",
      description: "Write a file",
      channel: "terminal",
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.string(),
      run: ({ path, content }) => {
        log(`write ${path}=${content}`);
        return Promise.resolve(`wrote ${path}`);
      },
    }),
    defineTool({
      name: "wait",
      description: "Wait",
      input: z.object({ ms: z.number() }),
      output: z.string(),
      run: async ({ ms }, ctx) => {
        await sleep(ms, ctx.signal);
        log(`waited ${String(ms)}`);
        return `waited ${String(ms)}`;
      },
    }),
    defineTool({
      name: "boom",
      description: "Always fails",
      input: z.object({}),
      output: z.string(),
      run: () => Promise.reject(new Error("disk on fire")),
    }),
  ];
}
