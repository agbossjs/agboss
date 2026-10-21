import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { ResolvedModelSettings } from "../config/types.js";
import type { Clock } from "../infrastructure/clock.js";
import { asError, TestFailure } from "./errors.js";
import type { ChatLine, ModelRequest, ScriptBook } from "./script-book.js";
import { extractText } from "../graph/multimodal.js";
import { scriptedCall, waitBeforeAnswer } from "./scripted-call.js";
import { replyOf } from "./scripted-replies.js";
import type { ScriptedCall } from "./turns.js";
import type { RecordedInput } from "./input-match.js";

const lineOf = (message: BaseMessage): ChatLine => ({
  role: message.type,
  text: message.content,
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

  /** Answers by the script; a text reply streams as one token, as a streaming provider would. */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { book, clock, key } = this.site;
    const script = book.scriptOf(key);
    const reported = <T>(work: () => T): T => {
      try {
        return work();
      } catch (error) {
        if (error instanceof TestFailure) book.report(error);
        throw asError(error);
      }
    };
    const request = { ...chatRequestOf(messages), tools: this.tools };
    const call: ScriptedCall = reported(() =>
      scriptedCall(script, request, undefined, this.site.input, key),
    );
    await waitBeforeAnswer(clock, call, options.signal);
    const site = { book, script, settings: this.settings, tools: this.tools };
    const message: AIMessage = reported(() => replyOf(site, call));
    if (message.text !== "") await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }
}
