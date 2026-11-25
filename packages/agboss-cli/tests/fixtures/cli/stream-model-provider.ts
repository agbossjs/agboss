import {
  CircuitBreakerPolicy,
  ModelCost,
  ModelProvider,
  OpenRouterDriver,
} from "../../../../agboss/src/models/index.js";
import { env, secret } from "../../../../agboss/src/index.js";
import { minutes, seconds } from "../../../../agboss/src/units/index.js";

/**
 * The provider of the streaming fixtures: OpenRouter's wire, the key in `OPENROUTER_API_KEY` and the
 * server's address in `OPENROUTER_BASE_URL` — a test points it at a 127.0.0.1 stub.
 */
@ModelProvider({
  name: "stream-model-provider",
  description: "OpenRouter's wire, at the address the test names",
  driver: OpenRouterDriver({
    apiKey: secret("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", { default: "https://openrouter.ai/api/v1" }),
  }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
})
export class StreamModelProvider {}
