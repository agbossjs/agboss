import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { JevDecisionRequest } from "../llm/jev-client.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import type { ProviderFetch } from "./resilient-fetch.js";

/** How a provider is reached: its base URL, key (when it has one) and HTTP client. */
export interface ProviderConnection {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /** `fetch` with the provider's timeout, retry policy and circuit breaker. */
  readonly fetch: ProviderFetch;
}

/** A chat model request: the settings with reasoning and caching resolved over the provider's own. */
export interface ChatRequest {
  readonly settings: ResolvedModelSettings;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
  readonly connection: ProviderConnection;
}

/** A decision request (OpenRouter Decisions API: every decision model, choice / noul / score questions). */
export interface DecideRequest {
  readonly decision: JevDecisionRequest;
  readonly connection: ProviderConnection;
}

/**
 * The contract of a model provider (`@ModelProvider` class): chat models, decisions, or both, and
 * what each model supports. `OpenAiCompatibleProvider` and `DecisionsModelProvider` implement it.
 */
export interface ModelProviderHandler {
  readonly chat?: (request: ChatRequest) => BaseChatModel;
  readonly routeTo?: (request: DecideRequest) => Promise<unknown>;
  /** `undefined` = the provider does not serve this model (`model.unknown-model`). */
  readonly capabilities: (
    model: string,
    connection: ProviderConnection,
  ) => Promise<ModelCapabilities | undefined>;
}
