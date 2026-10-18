import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { ResolvedModelSettings } from "../config/types.js";
import { asError, TestFailure } from "./errors.js";
import { ModelCallFailedError, type ScriptedTurn } from "./script.js";
import type { ChatLine, ComponentScript, ModelRequest, ScriptBook } from "./script-book.js";
import { extractText } from "../graph/multimodal.js";
import { LAUNCH_ANSWER_TOOL } from "../prompts/router-launch.js";
import { ARBITER_ANSWER_TOOL } from "../prompts/arbiter.js";

/** The yes/no answer tools a chat model answers like a decision model (`decideWith`). */
const YES_NO_TOOLS: ReadonlySet<string> = new Set([LAUNCH_ANSWER_TOOL, ARBITER_ANSWER_TOOL]);

/** Output tokens that cost `usd` at the model's output price (no price or a free model → none). */
const tokensFor = (usd: number, settings: ResolvedModelSettings): number =>
  settings.price === undefined || settings.price.outputPerMTok === 0
    ? 0
    : (usd * 1_000_000) / settings.price.outputPerMTok;

/** A model without a price reports its cost in the replyWith, as the provider would. */
const costMetadataOf = (usd: number, settings: ResolvedModelSettings) =>
  settings.price === undefined ? { usage: { cost: usd } } : {};

const usageOf = (outputTokens: number) => ({
  input_tokens: 0,
  output_tokens: outputTokens,
  total_tokens: outputTokens,
});

const lineOf = (message: BaseMessage): ChatLine => ({
  role: message.type,
  text: message.content,
});

/** An answer tool's name: `answer-<kebab of the DTO class>` (#272 S6). */
const ANSWER_TOOL = /^answer-[a-z0-9-]+-dto$/;

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

type TurnOf<TKind extends ScriptedTurn["kind"]> = Extract<ScriptedTurn, { kind: TKind }>;

/** A scripted text answer, with its cost (and a cut-off answer's finish reason). */
function textReplyOf(turn: TurnOf<"replyWith">, settings: ResolvedModelSettings): AIMessage {
  const cost = turn.details.cost ?? 0;
  return new AIMessage({
    content: turn.text,
    usage_metadata: usageOf(tokensFor(cost, settings)),
    response_metadata: {
      ...costMetadataOf(cost, settings),
      ...(turn.details.truncated === true ? { finish_reason: "length" } : {}),
    },
  });
}

/** A scripted tool call (or answer-tool call), with its cost. */
function toolCallReplyOf(
  turn: TurnOf<"tool-call">,
  book: ScriptBook,
  settings: ResolvedModelSettings,
): AIMessage {
  const cost = turn.details?.cost ?? 0;
  return new AIMessage({
    content: "",
    usage_metadata: usageOf(tokensFor(cost, settings)),
    response_metadata: costMetadataOf(cost, settings),
    tool_calls: [{ id: book.nextToolCallId(), name: turn.tool, args: { ...turn.args } }],
  });
}

/** One scripted turn as the model's reply. */
function replyOf(
  turn: ScriptedTurn,
  script: ComponentScript,
  book: ScriptBook,
  settings: ResolvedModelSettings,
  tools: readonly ToolDefinition[],
): AIMessage {
  switch (turn.kind) {
    case "replyWith":
      return textReplyOf(turn, settings);
    case "tool-call":
      // an answer through an answer tool (S6) is the agent's answer, not one of its tool calls
      if (!ANSWER_TOOL.test(turn.tool)) script.toolCalls.push(turn.tool);
      return toolCallReplyOf(turn, book, settings);
    case "failure":
      throw new ModelCallFailedError(turn.failure, script.label);
    case "decide": {
      const tool = tools.find((candidate) => YES_NO_TOOLS.has(candidate.function.name));
      if (tool !== undefined) return yesNoAnswerOf(turn, book, settings, tool.function.name);
      return wrongScript(script);
    }
    case "decision":
      return wrongScript(script);
  }
}

const wrongScript = (script: ComponentScript): never => {
  throw new TestFailure(
    "test.wrong-script",
    `${script.label} chats: script it with replyWith(…) / callTool(…), not routeTo(…) / decideWith(…)`,
  );
};

/**
 * A chat-model router before a launch (#273 S23) and a chat-model arbiter (#279) are scripted like a
 * decision model — `decideWith({ "refund-policy-agent": 1 })`, `decideWith({ counts: 0.9 })` — and
 * answer through their answer tool: P(yes) > 0.5 is `true`.
 */
function yesNoAnswerOf(
  turn: TurnOf<"decide">,
  book: ScriptBook,
  settings: ResolvedModelSettings,
  tool: string,
): AIMessage {
  const args = Object.fromEntries(
    Object.entries(turn.answers).map(([target, answer]) => [
      target,
      typeof answer === "number" ? answer > 0.5 : answer,
    ]),
  );
  const cost = turn.details.cost ?? 0;
  return new AIMessage({
    content: "",
    usage_metadata: usageOf(tokensFor(cost, settings)),
    response_metadata: costMetadataOf(cost, settings),
    tool_calls: [{ id: book.nextToolCallId(), name: tool, args }],
  });
}

/**
 * A chat model that answers by its component's script — by position, never by call order across
 * components — and records every request. Tool calling works (`createAgent` binds tools to it).
 */
export class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly book: ScriptBook,
    private readonly key: string,
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
    return new ScriptedChatModel(this.book, this.key, this.settings, definitions);
  }

  /** Answers by the script; a text reply streams as one token, as a streaming provider would. */
  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const script = this.book.scriptOf(this.key);
    const req = { ...chatRequestOf(messages), tools: this.tools };
    script.requests.push(req);
    let message: AIMessage;
    try {
      message = replyOf(script.next(req), script, this.book, this.settings, this.tools);
    } catch (error) {
      if (error instanceof TestFailure) this.book.report(error);
      throw asError(error);
    }
    if (message.text !== "") await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }
}
