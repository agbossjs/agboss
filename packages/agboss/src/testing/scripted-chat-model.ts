import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessageChunk,
  type AIMessage,
  type BaseMessage,
  type ContentBlock,
  type MessageContent,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import { partMetaOf, partOfBlock, partsOfContent } from "../models/content.js";
import type { ResolvedModelSettings } from "../config/types.js";
import type { Clock } from "../infrastructure/clock.js";
import { asError, TestFailure } from "./errors.js";
import type { ChatLine, ModelRequest, ScriptBook } from "./script-book.js";
import { extractText } from "../graph/multimodal.js";
import { scriptedCall, waitBeforeAnswer } from "./scripted-call.js";
import { replyOf } from "./scripted-replies.js";
import type { ScriptedCall } from "./turns.js";
import type { RecordedInput } from "./input-match.js";

/** A message's content as a test reads it: a file part as its meta, never its bytes (#899 §9). */
const shownContentOf = (content: MessageContent): MessageContent =>
  typeof content === "string"
    ? content
    : content.map((block): ContentBlock => {
        const part = partOfBlock(block);
        return part === undefined ? block : { ...partMetaOf(part) };
      });

const lineOf = (message: BaseMessage): ChatLine => ({
  role: message.type,
  text: shownContentOf(message.content),
});

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" && value !== null && "function" in value;

/** The input message (#270 Q51): the last human message before the model's first turn. */
function inputOf(lines: readonly ChatLine[]): ChatLine["text"] {
  const firstTurn = lines.findIndex((line) => line.role === "ai");
  const before = firstTurn === -1 ? lines : lines.slice(0, firstTurn);
  return before.filter((line) => line.role === "human").at(-1)?.text ?? "";
}

/** What an agent sent: its system prompt, its input message, every message. */
export function chatRequestOf(messages: readonly BaseMessage[]): ModelRequest {
  const lines = messages.map(lineOf);
  const system = lines.find((line) => line.role === "system")?.text;
  return {
    kind: "chat",
    system: system === undefined ? "" : extractText(system),
    input: inputOf(lines),
    messages: lines,
    tools: [],
    parts: messages.flatMap((message) => partsOfContent(message.content).map(partMetaOf)),
  };
}

/** Where a scripted chat model answers from: the test's scripts and clock, its component's key. */
export interface ScriptedChatSite {
  readonly book: ScriptBook;
  readonly clock: Clock;
  readonly key: string;
  /** What the call reads when it is not a step's (a reply interpreter's `{ ask, reply }`). */
  readonly input?: RecordedInput;
}

/**
 * A chat model that answers by its component's script — by the step's input (`when(…)`), then by
 * position, never by call order across components — and records every request. Tool calling
 * works (the agent loop binds tools to it); a `waitFor(…)` sleeps on the test's clock.
 */
export class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly site: ScriptedChatSite,
    private readonly settings: ResolvedModelSettings,
    private readonly tools: readonly ToolDefinition[] = [],
  ) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  /** The same script with the tools the agent bound: each request records them (#270 AC9). */
  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    const definitions = tools.filter((tool): tool is ToolDefinition => isToolDefinition(tool));
    return new ScriptedChatModel(this.site, this.settings, definitions);
  }

  #reported<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof TestFailure) this.site.book.report(error);
      throw asError(error);
    }
  }

  /**
   * Answers by the script; a text reply is one token, as a streaming provider would write it, and
   * `streamWith([…])` is one token per chunk — a stream that `failStreamAfter([…], failure)` breaks
   * has told its chunks when it fails (#1311, #1328).
   */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { book, clock, key } = this.site;
    const script = book.scriptOf(key);
    const request = { ...chatRequestOf(messages), tools: this.tools };
    const call: ScriptedCall = this.#reported(() =>
      scriptedCall(script, request, undefined, this.site.input, key),
    );
    await waitBeforeAnswer(clock, call, options.signal);
    const site = { book, script, settings: this.settings, tools: this.tools };
    const { turn } = call;
    // a stream read chunk by chunk (`_streamResponseChunks`) learns which turn this was
    if (runManager !== undefined && "kind" in runManager)
      (runManager as { kind?: typeof turn.kind }).kind = turn.kind;
    if (turn.kind === "stream" || turn.kind === "stream-failure")
      await tellChunks(turn.chunks, options.signal, runManager);
    const message: AIMessage = this.#reported(() => replyOf(site, call));
    if (message.text !== "" && turn.kind !== "stream")
      await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }

  /**
   * The same script as a stream a caller reads chunk by chunk (a fallback model's inner stream, a
   * `.stream()`). `streamWith([…])` gives its chunks as they were told, then one chunk with the
   * cost and finish reason; `failStreamAfter([…], failure)` gives its chunks, then fails. Any other
   * turn is one chunk carrying its whole reply (its tool calls as call chunks) — what the
   * non-streaming call gets.
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const told: string[] = [];
    const listening = {
      kind: undefined as ScriptedCall["turn"]["kind"] | undefined,
      handleLLMNewToken: async (token: string): Promise<void> => {
        told.push(token);
        await runManager?.handleLLMNewToken(token);
      },
    };
    const emit = (text: string): ChatGenerationChunk =>
      new ChatGenerationChunk({ message: new AIMessageChunk({ content: text }), text });
    const isStream = (): boolean =>
      listening.kind === "stream" || listening.kind === "stream-failure";
    let result: ChatResult;
    try {
      result = await this._generate(
        messages,
        options,
        listening as unknown as CallbackManagerForLLMRun,
      );
    } catch (error) {
      if (isStream()) for (const text of told) yield emit(text);
      throw error;
    }
    const [generation] = result.generations;
    if (generation === undefined) return;
    const message = generation.message as AIMessage;
    if (!isStream()) {
      yield chunkOf(message, generation.text);
      return;
    }
    for (const text of told) yield emit(text);
    yield chunkOf(message, "");
  }
}

/** The chunks of a scripted stream told to the run as tokens, the empty ones skipped. */
async function tellChunks(
  chunks: readonly string[],
  signal: AbortSignal | undefined,
  runManager: CallbackManagerForLLMRun | undefined,
): Promise<void> {
  for (const text of chunks) {
    if (text === "") continue;
    signal?.throwIfAborted();
    await runManager?.handleLLMNewToken(text);
  }
}

/** One chunk carrying the rest of a reply: `text`, its tool calls as call chunks, usage and finish reason. */
function chunkOf(message: AIMessage, text: string): ChatGenerationChunk {
  const calls = message.tool_calls ?? [];
  const cut = message.invalid_tool_calls ?? [];
  return new ChatGenerationChunk({
    text,
    message: new AIMessageChunk({
      content: text,
      tool_call_chunks: [
        ...calls.map((call, index) => ({
          type: "tool_call_chunk" as const,
          index,
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.args),
        })),
        ...cut.map((call, index) => ({
          type: "tool_call_chunk" as const,
          index: calls.length + index,
          id: call.id,
          name: call.name,
          args: call.args,
        })),
      ],
      ...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
      response_metadata: message.response_metadata,
    }),
  });
}
