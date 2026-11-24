/**
 * #1313 (was #521): `circuitBreakerPolicy`, `cost` and `retryPolicy` are optional on a `@ModelProvider` —
 * a provider without them assembles, with no breaker, no retry and no price; a breaker's `fallback`
 * without a policy of its own too.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import type { TransportModelProviderOptions } from "../../src/models/model-provider.decorator.js";
import { minutes, seconds } from "../../src/units/index.js";
import { bedrockApplicationOn } from "./transport/bedrock-apps.fixture.js";
import { answer } from "./transport/bedrock-provider.fixture.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const BREAKER = CircuitBreakerPolicy.fixed({
  failureThreshold: 1,
  failureWindow: minutes(1),
  openDuration: minutes(1),
});

const complete: TransportModelProviderOptions = {
  name: "unguarded-model-provider",
  description: "A transport whose options lost their breaker",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: BREAKER,
};

const {
  circuitBreakerPolicy: _breaker,
  cost: _cost,
  retryPolicy: _retry,
  ...withoutBreaker
} = complete;

@ModelProvider(withoutBreaker)
class UnguardedModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider({
  ...complete,
  name: "guarded-model-provider",
  circuitBreakerPolicy: BREAKER,
  fallback: UnguardedModelProvider,
})
class GuardedModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

describe("#1313: a model provider without circuitBreakerPolicy, cost or retryPolicy", () => {
  it("assembles", async () => {
    const application = bedrockApplicationOn({
      name: "unguarded-application",
      providers: [UnguardedModelProvider],
    });

    await expect(applicationOf(application, {})).resolves.toBeDefined();
  });

  it("is a breaker's fallback too", async () => {
    const application = bedrockApplicationOn({
      name: "fallback-unguarded-application",
      providers: [GuardedModelProvider],
    });

    await expect(applicationOf(application, {})).resolves.toBeDefined();
  });
});
