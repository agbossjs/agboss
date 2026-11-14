import type { RunnableConfig } from "@langchain/core/runnables";
import { agentStreamOf, type AttemptStream } from "../../run/stream/agent-stream.js";
import { AnswerTokenHandler, withAnswerHandler } from "../../run/stream/answer-handler.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { AgentLoopDeps } from "./deps.js";

/**
 * The model call of the agent's own answer, the one call of the framework the user's stream hears
 * (#1004): its tokens go to this attempt through a handler added to this call alone. An agent with
 * an output DTO answers with a tool call, not with text: it has no attempt, it streams none.
 */
export function answering(
  config: RunnableConfig | undefined,
  attempt: AttemptStream | undefined,
): RunnableConfig | undefined {
  if (attempt === undefined) return config;
  const handler = new AnswerTokenHandler((token) => {
    attempt.push(token);
  });
  return { ...config, callbacks: withAnswerHandler(config?.callbacks, handler) };
}

/** The visit's stream gives this model call its attempt, unless the agent answers with a tool. */
export const attemptOf = (
  config: RunnableConfig | undefined,
  deps: AgentLoopDeps,
  turn: number,
  tokens: PiiTokenMap | undefined,
): AttemptStream | undefined =>
  deps.agent.answerTools.tools.length > 0 ? undefined : agentStreamOf(config)?.begin(turn, tokens);
