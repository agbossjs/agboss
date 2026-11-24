import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  TRANSIENT_FAILURES,
  type NoRequestFields,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { bedrockApplicationOn, workflowsOn } from "../transport/bedrock-apps.fixture.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

/** #1005: HTTP providers whose answers stream — the answers of a real local server. */

const http = {
  timeout: seconds(30),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(2),
    jitter: false,
    // a cut stream is a network failure: this provider opts in to retrying it
    retryOn: [...TRANSIENT_FAILURES, ModelFailure.NetworkError],
  }),
};

/** A backup the breaker of the streaming primary falls back to. */
@ModelProvider({
  ...http,
  name: "stream-backup-1005-model-provider",
  description: "The backup",
  serves: [/^backup-stream\//],
  baseUrl: "http://backup-1005.test/v1",
  cost: ModelCost.fromPrices({
    "backup-stream/model": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
})
export class StreamBackupModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** The primary: priced by tokens, its breaker opens at two failed calls and falls back. */
@ModelProvider({
  ...http,
  name: "stream-1005-model-provider",
  description: "A streaming HTTP provider",
  serves: [/^stream\//],
  baseUrl: "http://primary-1005.test/v1",
  cost: ModelCost.fromPrices({
    "stream/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 2,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
  fallback: {
    provider: StreamBackupModelProvider,
    models: { "stream/model": "backup-stream/model" },
  },
})
export class StreamModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** A provider whose cost comes from its answers (OpenRouter's `usage.cost`), no fallback, no retry. */
@ModelProvider({
  ...http,
  name: "stream-cost-1005-model-provider",
  description: "A provider that reports each call's cost",
  serves: [/^cost-stream\//],
  baseUrl: "http://cost-1005.test/v1",
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 2,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
})
export class StreamCostModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

export const StreamApplication = bedrockApplicationOn({
  name: "stream-1005-application",
  desk: workflowsOn("stream/model", "stream-1005"),
  providers: [StreamModelProvider, StreamBackupModelProvider],
});

export const StreamCostApplication = bedrockApplicationOn({
  name: "stream-cost-1005-application",
  desk: workflowsOn("cost-stream/model", "stream-cost-1005"),
  providers: [StreamCostModelProvider],
});

/** #1231: OpenRouter's dialect — the call's cost in `usage.cost`, the host in each chunk's `provider`. */
@ModelProvider({
  ...http,
  name: "stream-or-1231-model-provider",
  description: "An OpenRouter that streams",
  serves: [/^or-stream\//],
  baseUrl: "http://or-1231.test/v1",
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 2,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
})
export class StreamOpenRouterProvider extends OpenRouterProvider {
  override readonly requestFields = {};
}

export const StreamOpenRouterApplication = bedrockApplicationOn({
  name: "stream-or-1231-application",
  desk: workflowsOn("or-stream/model", "stream-or-1231"),
  providers: [StreamOpenRouterProvider],
});
