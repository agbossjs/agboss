import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { JevDecisionRequest } from "../llm/jev-client.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import type { ProviderFetch } from "./resilient-fetch.js";
import type { ModelProviderRequest, ModelProviderResponse } from "./transport/transport.js";

/**
 * How a provider is reached: its base URL, key (when it has one) and HTTP client. A transport
 * provider's (#385) has neither base URL (`""`) nor key; its `fetch` still runs under its policies.
 */
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
 * what each model supports. `OpenAiCompatibleProvider` and `DecisionsModelProvider` implement it
 * over HTTP; a transport provider (#385) implements `complete` instead of `chat` — every policy of
 * the gateway runs around it.
 */
/** What of a provider's routing no endpoint of a model can serve (#395 PR 6): the setting, what exists. */
export interface RoutingProblem {
  /** The routing setting that cannot be met: `provider.only: fireworks`. */
  readonly value: string;
  /** The model's endpoints as the provider lists them. */
  readonly supported: string;
}

export interface ModelProviderHandler {
  readonly chat?: (request: ChatRequest) => BaseChatModel;
  readonly routeTo?: (request: DecideRequest) => Promise<unknown>;
  /**
   * A custom transport (#385): one chat call, made by the class itself (an SDK, a gateway). Throw
   * `ModelProviderFailureError` to say what failed (a 429, a timeout, a server error).
   */
  readonly complete?: (request: ModelProviderRequest) => Promise<ModelProviderResponse>;
  /**
   * `undefined` = the provider does not serve this model (`model.unknown-model`). Required of an
   * HTTP provider; a transport provider without it is not checked against its models' capabilities.
   */
  readonly capabilities?: (
    model: string,
    connection: ProviderConnection,
  ) => Promise<ModelCapabilities | undefined>;
  /**
   * What of the provider's host routing no endpoint of `model` can serve (#395 PR 6: OpenRouter's
   * pinned hosts and quantizations) — asked only by `agboss check --models`, over the network.
   */
  readonly routingProblems?: (
    model: string,
    connection: ProviderConnection,
  ) => Promise<readonly RoutingProblem[]>;
}
