/**
 * #521 AC1 — a `@ModelProvider` without `circuitBreakerPolicy` (the type requires it; a JS project
 * or a cast reaches this) fails the application's assembly with
 * `[model-provider.circuit-breaker-required]`, naming the provider and the field — never a crash
 * reading `.fallback` of nothing, at assembly, at `createApp` or as another provider's fallback.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
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
import {
  answer,
  BedrockModelProvider,
  ScriptedBedrockClient,
} from "./transport/bedrock-provider.fixture.js";
import { transportApp } from "./transport/transport-app.js";

const complete: TransportModelProviderOptions = {
  name: "unguarded-model-provider",
  description: "A transport whose options lost their breaker",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 1, window: minutes(1), openFor: minutes(1) },
};

/** What a JS project (or a cast) hands the decorator: the options without the policy. */
const { circuitBreakerPolicy: _dropped, ...withoutBreaker } = complete;

@ModelProvider(withoutBreaker as TransportModelProviderOptions)
class UnguardedModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider({
  ...complete,
  name: "guarded-model-provider",
  circuitBreakerPolicy: { ...complete.circuitBreakerPolicy, fallback: UnguardedModelProvider },
})
class GuardedModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

const REQUIRED =
  /\[model-provider\.circuit-breaker-required\] unguarded-model-provider \(UnguardedModelProvider\) has no circuitBreakerPolicy/;

describe("#521 AC1: a model provider without circuitBreakerPolicy", () => {
  it("AC1: assembly fails with [model-provider.circuit-breaker-required], naming the provider and the field", async () => {
    const application = bedrockApplicationOn({
      name: "unguarded-application",
      providers: [UnguardedModelProvider],
    });

    const assembled = applicationOf(application, {});

    await expect(assembled).rejects.toBeInstanceOf(GraphRuleError);
    await expect(assembled).rejects.toThrow(REQUIRED);
  });

  it("AC1: createApp rejects with the same assembly error, never a TypeError", async () => {
    const application = bedrockApplicationOn({
      name: "unguarded-start-application",
      providers: [UnguardedModelProvider],
    });

    const started = transportApp(application, { client: new ScriptedBedrockClient([]) });

    await expect(started).rejects.toBeInstanceOf(GraphRuleError);
    await expect(started).rejects.toThrow(REQUIRED);
  });

  it("AC1: a breaker's fallback without its own policy is named the same way", async () => {
    const application = bedrockApplicationOn({
      name: "fallback-unguarded-application",
      providers: [GuardedModelProvider],
    });

    await expect(applicationOf(application, {})).rejects.toThrow(REQUIRED);
  });

  it("AC1: a provider with its policy assembles as before", async () => {
    const application = bedrockApplicationOn({
      name: "guarded-application",
      providers: [BedrockModelProvider],
    });

    await expect(applicationOf(application, {})).resolves.toBeDefined();
  });
});
