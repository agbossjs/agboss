import { secret } from "../../src/environments/secret.js";
import {
  CachedPart,
  CacheRetention,
  ModelCost,
  ModelFailure,
  ModelProvider,
  DecisionsDriver,
  OpenAiCompatibleDriver,
  OpenRouterDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../src/models/index.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import {
  isDriverOptions,
  modelProviderOf,
  type DriverModelProviderOptions,
} from "../../src/models/model-provider.decorator.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 3,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

/** A backup OpenAI-compatible server: the fallback while OpenRouter's breaker is open. */
@ModelProvider({
  name: "backup-model-provider",
  description: "A backup server",
  driver: OpenAiCompatibleDriver({
    baseUrl: "http://backup.test/v1",
    apiKey: secret("BACKUP_KEY"),
  }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: breaker,
})
export class BackupModelProvider {}

/**
 * job-scout's OpenRouter: serves every model but the local server's (one model string, one
 * provider — #266), ignores one upstream provider.
 */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter",
  driver: OpenRouterDriver({
    baseUrl: "http://openrouter.test/api/v1",
    apiKey: secret("OPENROUTER_API_KEY"),
    routing: { ignore: ["Inceptron"] },
  }),
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.on({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: false,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  circuitBreakerPolicy: breaker,
  fallback: {
    provider: BackupModelProvider,
    models: { "moonshotai/kimi-k2.6": "backup/kimi-k2.6" },
  },
})
export class TestOpenRouterProvider {}

/** A local server with a price table: OpenAI's dialect, no key. */
@ModelProvider({
  name: "local-model-provider",
  description: "A local OpenAI-compatible server",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://local.test/v1" }),
  timeout: seconds(10),
  cost: ModelCost.fromPrices({
    "local/llama": {
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      cacheReadPerMillion: usd(0.5),
    },
  }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.on({
    retention: CacheRetention.OneDay,
    cachedParts: [CachedPart.SystemPrompt],
    key: "job-scout",
  }),
  retryPolicy: RetryPolicy.fixed({
    maxAttempts: 2,
    delay: seconds(1),
    retryOn: [ModelFailure.ServerError],
  }),
  circuitBreakerPolicy: breaker,
})
export class LocalModelProvider {}

/** A second provider serving `local/*` — two of them make a model ambiguous. */
@ModelProvider({
  name: "local-mirror-model-provider",
  description: "A mirror of the local server",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://mirror.test/v1" }),
  timeout: seconds(10),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: breaker,
})
export class LocalMirrorModelProvider {}

/** A decisions gateway: the default of the tests that ask a decision model. */
@ModelProvider({
  name: "decisions-model-provider",
  description: "Decision models on a decisions gateway",
  driver: DecisionsDriver({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: secret("OPENROUTER_API_KEY"),
  }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: breaker,
})
export class TestDecisionsProvider {}

/** A driver provider's options, to build another provider from (`{ ...driverOptionsOf(X), … }`). */
export function driverOptionsOf(cls: object): DriverModelProviderOptions {
  const options = modelProviderOf(cls);
  if (!isDriverOptions(options)) throw new Error(`${options.name} is not a driver provider`);
  return options;
}
