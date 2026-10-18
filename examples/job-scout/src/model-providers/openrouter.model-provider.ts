import {
  CachedPart,
  CacheRetention,
  EnvironmentVariable,
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenRouterProvider,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "agboss/models";
import { minutes, seconds } from "agboss/units";

/**
 * job-scout's chat models: OpenRouter, which returns each call's cost — listed with the framework's
 * `DecisionsModelProvider` (decision models: Jev, …; decisions only, no chat) in
 * `@Application({ providers })` (#266). Its key is `openRouterApiKey` of the application's
 * environment (`secret("OPENROUTER_API_KEY")` in `dev` and `staging`); its rate limit is OpenRouter's
 * plan for the whole application — every instance shares it through `SqliteRateLimitRepository`.
 */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — many models behind one OpenAI-compatible API",
  serves: [/.*/],
  baseUrl: EnvironmentVariable.named("OPENROUTER_BASE_URL", {
    secret: false,
    defaultValue: "https://openrouter.ai/api/v1",
  }),
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.whereSupported({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8,
    perMinute: { calls: 120 },
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class OpenRouterModelProvider extends OpenRouterProvider {
  // kimi-k2.6 via Inceptron loops while generating tool-call arguments (seen in #92, #97)
  override readonly requestFields: OpenRouterFields = { provider: { ignore: ["Inceptron"] } };
}
