import type { ToolDefinition } from "@langchain/core/language_models/base";
import { AIMessage } from "@langchain/core/messages";
import type { ResolvedModelSettings } from "../config/types.js";
import { answerToolName } from "../flow/analyse/rules/models.js";
import { ARBITER_ANSWER_TOOL } from "../prompts/arbiter.js";
import { GUARDRAIL_ANSWER_TOOL } from "../prompts/guardrail.js";
import { LAUNCH_ANSWER_TOOL } from "../prompts/router-launch.js";
import { TestFailure } from "./errors.js";
import { nodeNameOf } from "./failure-facts.js";
import { ModelCallFailedError } from "./script.js";
import type { ComponentScript } from "./component-script.js";
import type { ScriptBook } from "./script-book.js";
import type { ScriptedCall, TurnOf } from "./turns.js";

/** The yes/no answer tools a chat model answers like a decision model (`decideWith`). */
const YES_NO_TOOLS: ReadonlySet<string> = new Set([
  LAUNCH_ANSWER_TOOL,
  ARBITER_ANSWER_TOOL,
  GUARDRAIL_ANSWER_TOOL,
]);

/** Output tokens that cost `usd` at the model's output price (no price or a free model → none). */
const tokensFor = (usd: number, settings: ResolvedModelSettings): number =>
  settings.price === undefined || settings.price.outputPerMTok === 0
    ? 0
    : (usd * 1_000_000) / settings.price.outputPerMTok;

/** A model without a price reports its cost in the reply, as the provider would. */
const costMetadataOf = (usd: number, settings: ResolvedModelSettings) =>
  settings.price === undefined ? { usage: { cost: usd } } : {};

const usageOf = (outputTokens: number) => ({
  input_tokens: 0,
  output_tokens: outputTokens,
  total_tokens: outputTokens,
});

/** What a reply is built from: the script's book and the model's settings and bound tools. */
export interface ReplySite {
  readonly book: ScriptBook;
  readonly script: ComponentScript;
  readonly settings: ResolvedModelSettings;
  readonly tools: readonly ToolDefinition[];
}

/** A reply that calls one tool (an answer tool, an agent's tool, a yes/no tool), with its cost. */
function toolCallReply(
  site: ReplySite,
  name: string,
  args: Readonly<Record<string, unknown>>,
  cost = 0,
): AIMessage {
  return new AIMessage({
    content: "",
    usage_metadata: usageOf(tokensFor(cost, site.settings)),
    response_metadata: costMetadataOf(cost, site.settings),
    tool_calls: [{ id: site.book.nextToolCallId(), name, args: { ...args } }],
  });
}

/** A scripted text answer, with its cost (and a cut-off answer's finish reason). */
function textReply(turn: TurnOf<"reply">, settings: ResolvedModelSettings): AIMessage {
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

/** An answer through the answer tool of its class (#272 S6): a list output as `items`. */
function answerReply(site: ReplySite, turn: TurnOf<"answer">): AIMessage {
  const args = Array.isArray(turn.value)
    ? { items: turn.value as readonly unknown[] }
    : Object.fromEntries(Object.entries(turn.value ?? {}));
  return toolCallReply(site, answerToolName(turn.dto), args, turn.details.cost);
}

const wrongScript = (script: ComponentScript): never => {
  throw new TestFailure(
    "test.wrong-script",
    `${script.label} chats: script it with replyWith(…) / callTool(…), not routeTo(…) / decideWith(…)`,
  );
};

/** The yes/no tool the agent bound (a router before a launch, an arbiter), if any. */
const yesNoToolOf = (site: ReplySite): ToolDefinition | undefined =>
  site.tools.find((candidate) => YES_NO_TOOLS.has(candidate.function.name));

/**
 * A chat-model router before a launch (#273 S23), a chat-model arbiter (#279) and a chat-model
 * guardrail (#120) are scripted like a decision model — `decideWith({ "refund-policy-agent": 1 })`,
 * `decideWith({ counts: 0.9 })`, `decideWith({ blocks: 0.9 })` — and answer through their answer
 * tool: P(yes) > 0.5 is `true`.
 */
function decideReply(site: ReplySite, turn: TurnOf<"decide">): AIMessage {
  const tool = yesNoToolOf(site);
  if (tool === undefined) return wrongScript(site.script);
  const args = Object.fromEntries(
    Object.entries(turn.answers).map(([target, answer]) => [
      target,
      typeof answer === "number" ? answer > 0.5 : answer,
    ]),
  );
  return toolCallReply(site, tool.function.name, args, turn.details.cost);
}

/** The fields of a tool's arguments: the yes/no questions it asks. */
function propertiesOf(tool: ToolDefinition): readonly string[] {
  const parameters: unknown = tool.function.parameters;
  if (typeof parameters !== "object" || parameters === null || !("properties" in parameters))
    return [];
  const properties: unknown = parameters.properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}

/** `routeTo(…)` of a chat-model router before a launch: yes for each target, no for the others. */
function launchReply(site: ReplySite, turn: TurnOf<"route">): AIMessage {
  const tool = yesNoToolOf(site);
  if (tool?.function.name !== LAUNCH_ANSWER_TOOL) return wrongScript(site.script);
  const properties = propertiesOf(tool);
  const launched = turn.targets.map(nodeNameOf);
  const unknown = launched.filter((name) => !properties.includes(name));
  if (unknown.length > 0) {
    const routes = properties.join(", ");
    const message = `routeTo(${unknown.join(", ")}) for ${site.script.label}: not among the routes it launches (${routes})`;
    throw new TestFailure("test.not-a-route", message);
  }
  const args = Object.fromEntries(properties.map((name) => [name, launched.includes(name)]));
  return toolCallReply(site, tool.function.name, args, turn.details.cost);
}

/** One scripted call's turn as the model's reply. */
export function replyOf(site: ReplySite, call: ScriptedCall): AIMessage {
  const { turn } = call;
  switch (turn.kind) {
    case "reply":
      return textReply(turn, site.settings);
    case "answer":
      return answerReply(site, turn);
    case "tool-call":
      site.script.toolCalls.push(turn.tool);
      return toolCallReply(site, turn.tool, turn.args);
    case "failure":
      throw new ModelCallFailedError(turn.failure, site.script.label);
    case "decide":
      return decideReply(site, turn);
    case "route":
      return launchReply(site, turn);
  }
}
