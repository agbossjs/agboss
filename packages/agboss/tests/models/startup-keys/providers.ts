import { secret } from "../../../src/environments/secret.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
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
  driver: OpenAiCompatibleDriver({
    baseUrl: "http://keyed.test/v1",
    apiKey: secret("KEYED_API_KEY"),
  }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: breaker,
})
export class KeyedModelProvider {}

/** A keyless local server whose breaker falls back to the keyed one (#716: a fallback is connected at start). */
@ModelProvider({
  name: "fallback-local-model-provider",
  description: "A local server that falls back to the keyed one",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://local.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: breaker,
  fallback: { provider: KeyedModelProvider, models: { "local/llama": "keyed/llama" } },
})
export class FallbackLocalModelProvider {}
