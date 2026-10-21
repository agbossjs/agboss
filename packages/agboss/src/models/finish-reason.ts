import type { AIMessage } from "@langchain/core/messages";

/** Why a chat model stopped: the OpenAI contract's `finish_reason` (OpenRouter reports it too). */
export enum FinishReason {
  /** Cut at the call's `max_tokens`. */
  Length = "length",
}

/** Whether the answer was cut at the call's `max_tokens` (`finish_reason: "length"`). */
export const isCutAtLimit = (message: AIMessage): boolean =>
  (message.response_metadata as { readonly finish_reason?: unknown }).finish_reason ===
  FinishReason.Length;
