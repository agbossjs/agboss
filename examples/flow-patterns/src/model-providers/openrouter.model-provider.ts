import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenRouterProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "agboss/models";
import { minutes, seconds } from "agboss/units";

/**
 * The application's chat models through OpenRouter (#266) — the built-in provider's settings, with
 * its `serves` narrowed to the `moonshotai/…` models, so `harness/…` goes to
 * `HarnessModelProvider` alone (one model, one provider: `[model.ambiguous-provider]` otherwise).
 */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — the chat models of a real run",
  serves: [/^moonshotai\//],
  baseUrl: "https://openrouter.ai/api/v1",
  baseUrlField: "openRouterBaseUrl",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class FlowPatternsOpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}
