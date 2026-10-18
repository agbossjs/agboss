import { minutes, seconds } from "../units/index.js";
import { ModelCost } from "./cost.js";
import { NOT_A_DECISION_MODEL } from "./decision-models.js";
import { OPENROUTER_API_KEY_FIELD, OPENROUTER_BASE_URL_SETTING } from "./jev.provider.js";
import { ModelProvider } from "./model-provider.decorator.js";
import { OpenRouterProvider, type OpenRouterFields } from "./openrouter.provider.js";
import { CachedPart, CacheRetention, PromptCaching } from "./prompt-caching.js";
import { Reasoning } from "./reasoning.js";
import { RetryPolicy, TRANSIENT_FAILURES } from "./retry-policy.js";

/**
 * The default chat provider of a workflow that registers none: every model but the decision models
 * (`DECISION_MODELS`) on OpenRouter,
 * the cost from its answers, reasoning left to the model, caching where the model supports it.
 */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — many models behind one OpenAI-compatible API",
  serves: [NOT_A_DECISION_MODEL],
  baseUrl: OPENROUTER_BASE_URL_SETTING,
  apiKey: OPENROUTER_API_KEY_FIELD,
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
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class OpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}
