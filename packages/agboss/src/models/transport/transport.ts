import type { Usd } from "../../units/index.js";
import type { FinishReason } from "../finish-reason.js";
import type { PromptCaching } from "../prompt-caching.js";
import type { Reasoning } from "../reasoning.js";

/**
 * A custom transport (#385): what a `@ModelProvider` that `implements ModelProviderHandler` with
 * `complete(request)` reads and answers — the framework's own plain data, no LangChain type. The
 * gateway around it (serves, budgets and the ledger, the rate limit and its 429 pause, retries,
 * the breaker and its fallback, PII, answer tools, traces, `mockLlm`) is the same as for HTTP.
 */

/** Who wrote a message of a request. */
export enum ModelProviderMessageRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
  /** A tool's result, answering the assistant's call `toolCallId`. */
  Tool = "tool",
}

/** A tool call of the model: its id, the tool's name and its arguments (parsed JSON). */
export interface ModelProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** One message of the conversation, masked by the element's PII policies; text only. */
export interface ModelProviderMessage {
  readonly role: ModelProviderMessageRole;
  readonly text: string;
  /** An assistant message's tool calls; absent = none. */
  readonly toolCalls?: readonly ModelProviderToolCall[];
  /** A tool message: the id of the call it answers. */
  readonly toolCallId?: string;
}

/** A tool the model may call — the agent's own and its answer tools (`answer-<dto>`). */
export interface ModelProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Its arguments as a JSON Schema object. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** What one call used; `inputTokens` includes the cached ones (OpenAI-compatible accounting). */
export interface ModelProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** One model call as the gateway hands it to `complete(request)`. */
export interface ModelProviderRequest {
  /** The model served (with a breaker's fallback: its `fallbackModels` entry). */
  readonly model: string;
  readonly messages: readonly ModelProviderMessage[];
  /** Empty when the caller binds none. */
  readonly tools: readonly ModelProviderToolDefinition[];
  readonly temperature: number;
  /** `undefined` = `TokenLimit.MODEL_MAX`: no ceiling of the framework's own. */
  readonly maxTokens: number | undefined;
  /** The component's, else the provider's (`Reasoning.off()` when it sets none). */
  readonly reasoning: Reasoning;
  /** The component's, else the provider's (`PromptCaching.off()` when it sets none). */
  readonly promptCaching: PromptCaching;
  /** The attempt's `timeout`, the execution's cancel and an exhausted budget: pass it to the SDK. */
  readonly signal: AbortSignal;
}

/** The model's answer: its text, its tool calls, what it used and, when known, its exact cost. */
export interface ModelProviderResponse {
  readonly text: string;
  readonly toolCalls?: readonly ModelProviderToolCall[];
  readonly usage: ModelProviderUsage;
  /**
   * The call's exact cost (`costSource: "api"`); absent = tokens × the decorator's
   * `ModelCost.fromPrices(…)` — with `ModelCost.fromResponse()` an answer without it cannot be accounted.
   */
  readonly cost?: Usd;
  readonly finishReason?: FinishReason;
}
