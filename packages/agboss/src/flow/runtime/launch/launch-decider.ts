import type { ToolDefinition } from "@langchain/core/language_models/base";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatDefaults, ResolvedModelSettings, RouterModel } from "../../../config/types.js";
import { recordUsage, type UsageRecord } from "../../../finops/usage.js";
import { DecisionResponseError } from "../../../llm/decision-errors.js";
import { Decision, type DecisionQuestions } from "../../../llm/decisions.js";
import type { ModelGateway } from "../../../llm/gateway.js";
import { resolveSettings } from "../../../llm/registry.js";
import {
  LAUNCH_ANSWER_DESCRIPTION,
  LAUNCH_ANSWER_TOOL,
  LAUNCH_ROUTER_SYSTEM,
} from "../../../prompts/router-launch.js";
import { routerCaller, type RouteOutcome } from "../../../routers/index.js";
import { withSortedKeys } from "../json.js";

/**
 * How a model router decides the `OnDemand` routes of a parallel launch (#273 S23): one model
 * call, one independent yes/no question per route — its text the route's prompt — keyed by the
 * target's `name` in the order of `@Router({ routes })`. A decision model answers one `decide` with
 * a `Decision.noul` per route; a chat model one answer tool with a boolean field per route (its keys
 * sorted, like every tool schema). A route is launched when its answer is yes: P(yes) > 0.5 — no
 * threshold setting. Every probability is kept for the trace.
 */

/** One `OnDemand` route as a question. */
export interface LaunchQuestion {
  /** The target's `name`: the question's key. */
  readonly target: string;
  /** The route's prompt: when to launch it. */
  readonly prompt: string;
}

/** What the router decides on: its input message, its own prompt and its questions. */
export interface LaunchDecisionRequest {
  readonly input: string;
  readonly instructions: string;
  readonly questions: readonly LaunchQuestion[];
}

/** The answer: the targets to launch (in the questions' order) and P(yes) of each. */
export interface LaunchDecided {
  readonly kind: "decided";
  readonly launched: readonly string[];
  readonly probabilities: Readonly<Record<string, number>>;
  readonly usage?: UsageRecord;
}

/** The decision, or why there is none (the call failed, or its answer is not readable). */
export type LaunchDecisionOutcome = LaunchDecided | Extract<RouteOutcome, { kind: "failed" }>;

/** A router's launch decisions on its model. */
export interface LaunchDecider {
  readonly decide: (request: LaunchDecisionRequest) => Promise<LaunchDecisionOutcome>;
}

/** What a launch decider is made of. */
export interface LaunchDeciderDeps {
  readonly gateway: ModelGateway;
  readonly chatDefaults: ChatDefaults;
}

const YES = 0.5;

function decidedOf(
  request: LaunchDecisionRequest,
  probabilities: Readonly<Record<string, number>>,
  usage: UsageRecord | undefined,
): LaunchDecided {
  const launched = request.questions
    .map((question) => question.target)
    .filter((target) => (probabilities[target] ?? 0) > YES);
  return { kind: "decided", launched, probabilities, ...(usage === undefined ? {} : { usage }) };
}

const failedOf = (error: unknown, usage?: UsageRecord): LaunchDecisionOutcome => {
  const reason = error instanceof Error ? error.message : String(error);
  const answered = error instanceof DecisionResponseError;
  return {
    kind: "failed",
    reason,
    ...(usage === undefined ? {} : { usage }),
    ...(answered ? {} : { cause: error }),
  };
};

async function decideOnDecisionModel(
  name: string,
  model: string,
  gateway: ModelGateway,
  request: LaunchDecisionRequest,
): Promise<LaunchDecisionOutcome> {
  if (gateway.decide === undefined)
    return failedOf(new TypeError(`${name}: the model gateway has no decisions (${model})`));
  const questions: DecisionQuestions = Object.fromEntries(
    request.questions.map((question) => [question.target, Decision.noul(question.prompt)]),
  );
  const state = `${request.instructions}\n\n${request.input}`;
  try {
    const caller = routerCaller(name);
    const outcome = await gateway.decide({ caller, model, request: { state, questions } });
    const probabilities = Object.fromEntries(
      Object.entries(outcome.answers).map(([id, answer]) => [
        id,
        answer.type === "noul" ? answer.noul : 0,
      ]),
    );
    return decidedOf(request, probabilities, outcome.usage);
  } catch (error) {
    return failedOf(error);
  }
}

function answerToolOf(request: LaunchDecisionRequest): ToolDefinition {
  const properties = Object.fromEntries(
    request.questions.map((question) => [
      question.target,
      { type: "boolean", description: question.prompt },
    ]),
  );
  const required = request.questions.map((question) => question.target).sort();
  return {
    type: "function",
    function: {
      name: LAUNCH_ANSWER_TOOL,
      description: LAUNCH_ANSWER_DESCRIPTION,
      parameters: withSortedKeys({ type: "object", properties, required }),
    },
  };
}

/** The booleans of the answer tool's call; a missing or non-boolean answer is not readable. */
function answersOf(reply: AIMessage, request: LaunchDecisionRequest): Record<string, number> {
  const call = reply.tool_calls?.find((candidate) => candidate.name === LAUNCH_ANSWER_TOOL);
  if (call === undefined)
    throw new DecisionResponseError(`no ${LAUNCH_ANSWER_TOOL} call in the router's reply`);
  const args: Readonly<Record<string, unknown>> = call.args;
  return Object.fromEntries(
    request.questions.map(({ target }) => {
      const answer = args[target];
      if (typeof answer !== "boolean")
        throw new DecisionResponseError(`${LAUNCH_ANSWER_TOOL}: "${target}" is not true or false`);
      return [target, answer ? 1 : 0];
    }),
  );
}

async function decideOnChatModel(
  name: string,
  settings: ResolvedModelSettings,
  gateway: ModelGateway,
  request: LaunchDecisionRequest,
): Promise<LaunchDecisionOutcome> {
  const caller = routerCaller(name);
  const chat = gateway.chatModel({ user: { kind: "router", router: name }, settings });
  if (chat.bindTools === undefined)
    return failedOf(new TypeError(`${name}: ${settings.model} cannot call tools`));
  let usage: UsageRecord | undefined;
  try {
    const messages = [
      new SystemMessage(`${LAUNCH_ROUTER_SYSTEM}\n\n${request.instructions}`),
      new HumanMessage(request.input),
    ];
    const reply = await chat.bindTools([answerToolOf(request)]).invoke(messages);
    const message = reply instanceof AIMessage ? reply : new AIMessage({ content: reply.content });
    usage = recordUsage(caller, settings, message);
    return decidedOf(request, answersOf(message, request), usage);
  } catch (error) {
    return failedOf(error, usage);
  }
}

/** The launch decider of a router on its model: a decision model, or a chat model. */
export function createLaunchDecider(
  name: string,
  model: RouterModel,
  deps: LaunchDeciderDeps,
): LaunchDecider {
  return {
    decide: (request) =>
      model.kind === "jev"
        ? decideOnDecisionModel(name, model.model, deps.gateway, request)
        : decideOnChatModel(name, resolveSettings(model, deps.chatDefaults), deps.gateway, request),
  };
}
