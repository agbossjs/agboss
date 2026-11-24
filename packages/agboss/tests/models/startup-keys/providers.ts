import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../../src/models/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 3,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

/** The provider every model of a startup case that must fail serves: its key is the environment's field `keyedApiKey`. */
@ModelProvider({
  name: "keyed-model-provider",
  description: "A server that needs a key",
  serves: [/^keyed\//],
  baseUrl: "http://keyed.test/v1",
  apiKey: "keyedApiKey",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
})
export class KeyedModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** A keyless local server whose breaker falls back to the keyed one (#716: a fallback is connected at start). */
@ModelProvider({
  name: "fallback-local-model-provider",
  description: "A local server that falls back to the keyed one",
  serves: [/^local\//],
  baseUrl: "http://local.test/v1",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
  fallback: { provider: KeyedModelProvider, models: { "local/llama": "keyed/llama" } },
})
export class FallbackLocalModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
