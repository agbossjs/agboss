/**
 * #1366: the assembly's rules on a listed `@ModelProvider` (mode, breaker, timeout, price), called
 * directly: each violation's code, its exact message and the node it names, for a listed provider and for the
 * fallback of its breaker, and none when the list is empty or absent. The shard `assembly-rules` mutates them.
 */
import { describe, expect, it } from "vitest";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import type {
  DriverModelProviderOptions,
  TransportModelProviderOptions,
} from "../../src/models/model-provider.decorator.js";
import {
  providerModeViolations,
  providerPriceViolations,
  providerTimeoutViolations,
} from "../../src/models/provider-mode-rules.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { answer } from "./transport/bedrock-provider.fixture.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 1,
  failureWindow: minutes(1),
  openDuration: minutes(1),
});

const transport = (name: string): TransportModelProviderOptions => ({
  name,
  description: "A transport",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: breaker,
});

const driven = (name: string): DriverModelProviderOptions => ({
  name,
  description: "An HTTP server",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://server.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: breaker,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
});

class Handler implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

// a driver that also has complete(request): both modes at once (a runtime rule: the types allow a method)
@ModelProvider(driven("both-model-provider"))
class BothMode extends Handler {}

// @ts-expect-error -- deps without complete(request): not a transport
@ModelProvider({ ...transport("deps-model-provider"), deps: [BothMode] })
class DepsOnly {}

// @ts-expect-error -- neither a driver nor complete(request)
@ModelProvider(transport("neither-model-provider"))
class Neither {}

@ModelProvider(transport("fine-model-provider"))
class Fine extends Handler {}

@ModelProvider({
  ...transport("guarded-model-provider"),
  circuitBreakerPolicy: breaker,
  fallback: BothMode,
})
class WithBadFallback extends Handler {}

/** A transport whose constructor needs what the container gives it: never built to read its fields. */
// @ts-expect-error -- a constructor that takes what the container gives it, with no deps listed
@ModelProvider(transport("needy-model-provider"))
class NeedsArguments extends Handler {
  constructor(region: string) {
    super();
    if (region.length === 0) throw new Error("empty");
  }
}

const slow = seconds(MAX_TIMEOUT / 1000 + 1);

@ModelProvider({ ...transport("slow-model-provider"), timeout: slow })
class Slow extends Handler {}

const priced = (name: string, cost: ModelCost): TransportModelProviderOptions => ({
  ...transport(name),
  cost,
});
const table = (field: string, value: unknown): ModelCost => ({
  kind: "from-prices",
  prices: { m: { inputPerMillion: usd(1), outputPerMillion: usd(2), [field]: value } },
});

@ModelProvider(priced("negative-model-provider", table("inputPerMillion", -5)))
class Negative extends Handler {}

@ModelProvider(
  priced(
    "zero-model-provider",
    ModelCost.fromPrices({ m: { inputPerMillion: usd(0), outputPerMillion: usd(0) } }),
  ),
)
class Zero extends Handler {}

@ModelProvider({
  ...priced("outer-model-provider", ModelCost.fromResponse()),
  circuitBreakerPolicy: breaker,
  fallback: Negative,
})
class OuterOfNegative extends Handler {}

const APP = "rules-application";

describe("#1366: providerModeViolations", () => {
  it("names a driver provider that also implements complete", () => {
    expect(providerModeViolations(APP, [BothMode])).toEqual([
      {
        code: "model-provider.both-modes",
        message:
          "both-model-provider (BothMode) sets a driver and implements complete(request) — the driver makes its calls: remove the method",
        nodes: [APP],
      },
    ]);
  });

  it("names deps without complete, and a provider with neither mode", () => {
    expect(providerModeViolations(APP, [DepsOnly, Neither]).map((found) => found.message)).toEqual([
      "deps-model-provider (DepsOnly) has deps but no complete(request) — only a transport provider is created by the container",
      "neither-model-provider (Neither) has neither a driver nor complete(request) (a transport)",
    ]);
  });

  it("reads a breaker's fallback too, and finds nothing in a good list, an empty one or none", () => {
    expect(providerModeViolations(APP, [WithBadFallback]).map((found) => found.message)).toEqual([
      expect.stringContaining("both-model-provider (BothMode)"),
    ]);
    expect(providerModeViolations(APP, [Fine])).toEqual([]);
    expect(providerModeViolations(APP, [])).toEqual([]);
    expect(providerModeViolations(APP, undefined)).toEqual([]);
  });
});
