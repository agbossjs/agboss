/**
 * `@agboss/core/models` — model providers: `@ModelProvider` classes (`OpenAiCompatibleProvider`,
 * `OpenRouterProvider`, `DecisionsModelProvider`, or a transport's `complete(request)`, #385),
 * what each model costs, how it reasons and caches, retries, rate limits and circuit breakers, and
 * the fail-fast check of settings against models.
 * Wiki → Model providers.
 */
export {
  ModelProvider,
  ModelProviderError,
  type ModelProviderOptions,
  type ModelProviderType,
} from "./model-provider.decorator.js";
export type {
  ChatRequest,
  DecideRequest,
  ModelProviderHandler,
  ProviderConnection,
} from "./handler.js";
export {
  ModelProviderMessageRole,
  type ModelProviderMessage,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelProviderToolCall,
  type ModelProviderToolDefinition,
  type ModelProviderUsage,
} from "./transport/transport.js";
export {
  ModelProviderFailureError,
  type ModelProviderFailureOptions,
} from "./transport/failure-error.js";
export { FinishReason } from "./finish-reason.js";
export type { ModelCapabilities, PromptCachingSupport, ReasoningSupport } from "./capabilities.js";
export {
  OpenAiCompatibleProvider,
  type CachingRequest,
  type NoRequestFields,
} from "./openai-compatible.provider.js";
export {
  OpenRouterProvider,
  type OpenRouterFields,
  ProviderSort,
  Quantization,
  type OpenRouterRouting,
} from "./openrouter.provider.js";
export { OpenRouterModelProvider } from "./openrouter-model.provider.js";
export { DecisionsModelProvider, JEV_MODELS, OPENROUTER_BASE_URL } from "./jev.provider.js";
export { DECISION_MODELS, isDecisionModel } from "./decision-models.js";
// the deprecated `JevModelProvider` alias (a star export: re-exporting it by name is itself deprecated use)
export * from "./jev-alias.js";
export { ModelCost, type ModelPrice, type ModelPrices } from "./cost.js";
export {
  Reasoning,
  ReasoningEffort,
  ReasoningError,
  type ReasoningBudget,
  type ReasoningOnOptions,
} from "./reasoning.js";
export {
  CachedPart,
  CacheRetention,
  PromptCaching,
  PromptCachingError,
  type PromptCachingOptions,
} from "./prompt-caching.js";
export {
  Backoff,
  RetryPolicy,
  RetryPolicyError,
  TRANSIENT_FAILURES,
  type ExponentialRetryOptions,
  type FixedRetryOptions,
} from "./retry-policy.js";
export { ModelFailure } from "./model-failure.js";
export {
  CircuitBreaker,
  ModelCallError,
  type CircuitBreakerPolicy,
  type CircuitBreakerStore,
  type ModelCallErrorCode,
} from "./circuit-breaker.js";
export {
  QueueBalancingStrategy,
  RateLimitPolicy,
  RateLimitPolicyError,
  type PerMinuteLimits,
  type RateLimitOptions,
} from "./policies/rate-limit-policy.js";
export { ConfigurationError, type ModelProblem, type ModelProblemCode } from "./problems.js";
export { ModelPurpose, ModelProviderDirectory } from "./resolve.js";
export { DEFAULT_MODEL_PROVIDERS } from "./workflow-models.js";
export { toWireRequest, type WirePlan, type WireRequest } from "./wire.js";
