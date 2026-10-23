import {
  CachedPart,
  CacheRetention,
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
  type OpenRouterFields,
} from "../../src/models/index.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import {
  isHttpProvider,
  modelProviderOf,
  type HttpModelProviderOptions,
} from "../../src/models/model-provider.decorator.js";

const breaker = { failureThreshold: 3, window: minutes(1), openFor: seconds(30) };

/** A backup OpenAI-compatible server: the fallback while OpenRouter's breaker is open. */
@ModelProvider({
  name: "backup-model-provider",
  description: "A backup server",
  serves: [/^backup\//],
  baseUrl: "http://backup.test/v1",
  apiKey: "backupApiKey",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
})
export class BackupModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/**
 * job-scout's OpenRouter: serves every model but the local server's (one model string, one
 * provider — #266), ignores one upstream provider.
 */
@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter",
  serves: [/^(?!local\/)/],
  baseUrl: "http://openrouter.test/api/v1",
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
    jitter: false,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  circuitBreakerPolicy: {
    ...breaker,
    fallback: BackupModelProvider,
    fallbackModels: { "moonshotai/kimi-k2.6": "backup/kimi-k2.6" },
  },
})
export class TestOpenRouterProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = { provider: { ignore: ["Inceptron"] } };
}

/** A local server with a price table: OpenAI's dialect, no key. */
@ModelProvider({
  name: "local-model-provider",
  description: "A local OpenAI-compatible server",
  serves: [/^local\//],
  baseUrl: "http://local.test/v1",
  timeout: seconds(10),
  cost: ModelCost.fromPrices({
    "local/llama": {
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      cachedInputPerMillion: usd(0.5),
    },
  }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.whereSupported({
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
export class LocalModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** A second provider serving `local/*` — two of them make a model ambiguous. */
@ModelProvider({
  name: "local-mirror-model-provider",
  description: "A mirror of the local server",
  serves: [/^local\//],
  baseUrl: "http://mirror.test/v1",
  timeout: seconds(10),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
})
export class LocalMirrorModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** An HTTP provider's options, to build another HTTP provider from (`{ ...httpOptionsOf(X), … }`). */
export function httpOptionsOf(cls: object): HttpModelProviderOptions {
  const options = modelProviderOf(cls);
  if (!isHttpProvider(options)) throw new Error(`${options.name} is not an HTTP provider`);
  return options;
}
