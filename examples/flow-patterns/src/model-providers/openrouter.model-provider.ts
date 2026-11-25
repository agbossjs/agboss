import {
  CircuitBreakerPolicy,
  DecisionsDriver,
  ModelCost,
  ModelProvider,
  OpenRouterDriver,
  RetryPolicy,
  TRANSIENT_FAILURES,
} from "@agboss/core/models";
import { env, secret } from "@agboss/core";
import { minutes, seconds } from "@agboss/core/units";

const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 5,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

/** Every chat model of the application but the offline `harness/…` ones: OpenRouter, the key in `OPENROUTER_API_KEY`. */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — many models behind one OpenAI-compatible API",
  driver: OpenRouterDriver({
    apiKey: secret("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", { default: "https://openrouter.ai/api/v1" }),
  }),
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: breaker,
})
export class OpenRouterModelProvider {}

/** Jev and the other decision models, on OpenRouter's Decisions API. */
@ModelProvider({
  name: "decisions-model-provider",
  description: "Decision models on OpenRouter's Decisions API",
  driver: DecisionsDriver({
    apiKey: secret("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", { default: "https://openrouter.ai/api/v1" }),
  }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: breaker,
})
export class DecisionsModelProvider {}
