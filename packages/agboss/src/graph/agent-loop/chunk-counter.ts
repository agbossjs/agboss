import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import { partialUsageRecordOf } from "../../finops/partial-usage.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { AgentLoopDeps } from "./deps.js";

/**
 * Counts the text a model call streamed (#1399), so a call that fails mid-way is accounted for what
 * came: the provider bills it. Added to the one call's `callbacks`, awaited, and it never asks for
 * a streamed call (no `lc_prefer_streaming`): it only hears the calls that stream.
 */
export class ChunkCounter extends BaseCallbackHandler {
  name = "ChunkCounter";
  override awaitHandlers = true;
  #chars = 0;

  /** The characters of the text heard so far. */
  get chars(): number {
    return this.#chars;
  }

  override handleLLMNewToken(token: string): void {
    this.#chars += token.length;
  }
}

/** The call's callbacks with `counter` added; the others stay as they are. */
export function withChunkCounter(
  callbacks: Callbacks | undefined,
  counter: ChunkCounter,
): Callbacks {
  if (callbacks === undefined) return [counter];
  return Array.isArray(callbacks) ? [...callbacks, counter] : callbacks.copy([counter]);
}

/** The characters a request sends: what the prompt of the call is counted from. */
function requestChars(messages: readonly BaseMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      (typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length),
    0,
  );
}

/**
 * What a model call that failed had spent (#1399): its record (the provider's report carried by the
 * error, else counted from the chunks `counter` heard), counted in the budgets at once.
 */
export function partialSpendOf(
  deps: AgentLoopDeps,
  path: readonly string[],
  messages: readonly BaseMessage[],
  error: unknown,
  counter: ChunkCounter,
): readonly UsageRecord[] {
  const { name, binding } = deps.agent;
  const partial = partialUsageRecordOf(name, binding.settings, error, {
    requestChars: requestChars(messages),
    answerChars: counter.chars,
  });
  return partial === undefined ? [] : deps.budgets.tally([partial], path);
}
