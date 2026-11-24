import type { AIMessage } from "@langchain/core/messages";

/** Why a chat model stopped: the OpenAI contract's `finish_reason` (OpenRouter reports it too). */
export enum FinishReason {
  /** The model finished its answer. */
  Stop = "stop",
  /** Cut at the call's `max_tokens`. */
  Length = "length",
  /** The model stopped to call tools. */
  ToolCalls = "tool_calls",
  /** The provider's content filter stopped the answer. */
  ContentFilter = "content_filter",
}

const KNOWN: ReadonlySet<string> = new Set(Object.values(FinishReason));

/** A provider's own words for a reason the contract names. */
const ALIASES: Readonly<Record<string, FinishReason>> = {
  function_call: FinishReason.ToolCalls,
  end_turn: FinishReason.Stop,
  max_tokens: FinishReason.Length,
};

/** The reason a message says it stopped for, when it says one the contract knows. */
export function finishReasonOf(message: AIMessage): FinishReason | undefined {
  const reported = (message.response_metadata as { readonly finish_reason?: unknown })
    .finish_reason;
  if (typeof reported !== "string") return undefined;
  return KNOWN.has(reported) ? (reported as FinishReason) : ALIASES[reported];
}

/** Whether the answer was cut at the call's `max_tokens` (`finish_reason: "length"`). */
export const isCutAtLimit = (message: AIMessage): boolean =>
  finishReasonOf(message) === FinishReason.Length;
