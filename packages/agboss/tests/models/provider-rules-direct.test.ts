/**
 * #1366: the assembly's rules on a listed `@ModelProvider` (mode, breaker, request fields, timeout, price), called
 * directly: each violation's code, its exact message and the node it names, for a listed provider and for the
 * fallback of its breaker, and none when the list is empty or absent. The shard `assembly-rules` mutates them.
 */
import { describe, expect, it } from "vitest";
import {
  ModelCost,
  ModelProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import { OpenRouterProvider, type OpenRouterFields } from "../../src/models/openrouter.provider.js";
import type {
  HttpModelProviderOptions,
  TransportModelProviderOptions,
} from "../../src/models/model-provider.decorator.js";
import {
  providerBreakerViolations,
  providerFieldsViolations,
  providerModeViolations,
  providerPriceViolations,
  providerTimeoutViolations,
} from "../../src/models/provider-mode-rules.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { answer } from "./transport/bedrock-provider.fixture.js";

const breaker = { failureThreshold: 1, window: minutes(1), openFor: minutes(1) };

const transport = (name: string): TransportModelProviderOptions => ({
  name,
  description: "A transport",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
});

const http = (name: string): HttpModelProviderOptions => ({
  name,
  description: "An HTTP server",
  serves: [/^http\//],
  baseUrl: "http://server.test/v1",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
});

class Handler implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

// @ts-expect-error -- a transport with a base URL and a key: both modes at once
@ModelProvider({ ...transport("both-model-provider"), baseUrl: "http://a.test", apiKey: "aKey" })
class BothMode extends Handler {}

// @ts-expect-error -- a transport that also has chat: both modes at once
@ModelProvider(transport("chatty-model-provider"))
class ChattyTransport extends Handler {
  chat(): void {
    return undefined;
  }
}

// @ts-expect-error -- deps without complete(request): not a transport
@ModelProvider({ ...http("deps-model-provider"), deps: [BothMode] })
class DepsOnly {}

// @ts-expect-error -- neither a baseUrl nor complete(request)
@ModelProvider({ ...http("neither-model-provider"), baseUrl: undefined })
class Neither {}

@ModelProvider(transport("fine-model-provider"))
class Fine extends Handler {}

@ModelProvider({
  ...transport("guarded-model-provider"),
  circuitBreakerPolicy: { ...breaker, fallback: BothMode },
})
class WithBadFallback extends Handler {}

const { circuitBreakerPolicy: _dropped, ...withoutBreaker } = transport("unguarded-model-provider");
@ModelProvider(withoutBreaker as TransportModelProviderOptions)
class Unguarded extends Handler {}

@ModelProvider(http("bare-model-provider"))
// @ts-expect-error -- the abstract requestFields left out
class BareFields extends OpenRouterProvider {}

@ModelProvider(http("fielded-model-provider"))
class FieldedFields extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}

@ModelProvider(http("null-fields-model-provider"))
class NullFields extends OpenRouterProvider {
  override readonly requestFields = null as never;
}

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
  circuitBreakerPolicy: { ...breaker, fallback: Negative },
})
class OuterOfNegative extends Handler {}

const APP = "rules-application";

describe("#1366: providerModeViolations", () => {
  it("names a transport that sets the HTTP fields", () => {
    expect(providerModeViolations(APP, [BothMode])).toEqual([
      {
        code: "model-provider.both-modes",
        message:
          "both-model-provider (BothMode) implements complete(request) and sets baseUrl, apiKey — a transport makes its own calls: remove them",
        nodes: [APP],
      },
    ]);
  });

  it("names a transport that also has chat", () => {
    expect(providerModeViolations(APP, [ChattyTransport])).toEqual([
      {
        code: "model-provider.both-modes",
        message:
          "chatty-model-provider (ChattyTransport) has both chat(request) and complete(request) — keep one: HTTP (chat) or a transport (complete)",
        nodes: [APP],
      },
    ]);
  });

  it("names deps without complete, and a provider with neither mode", () => {
    expect(providerModeViolations(APP, [DepsOnly, Neither]).map((found) => found.message)).toEqual([
      "deps-model-provider (DepsOnly) has deps but no complete(request) — only a transport provider is created by the container",
      "neither-model-provider (Neither) has neither a baseUrl (HTTP) nor complete(request) (a transport)",
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

describe("#1366: providerBreakerViolations", () => {
  it("names a provider without a breaker policy, and finds nothing otherwise", () => {
    expect(providerBreakerViolations(APP, [Unguarded])).toEqual([
      {
        code: "model-provider.circuit-breaker-required",
        message:
          "unguarded-model-provider (Unguarded) has no circuitBreakerPolicy — set circuitBreakerPolicy: { failureThreshold, window, openFor } on its @ModelProvider",
        nodes: [APP],
      },
    ]);
    expect(providerBreakerViolations(APP, [Fine])).toEqual([]);
    expect(providerBreakerViolations(APP, undefined)).toEqual([]);
  });
});

describe("#1366: providerFieldsViolations", () => {
  it("names an OpenAI-compatible provider without requestFields, and not a transport or a fielded one", () => {
    expect(providerFieldsViolations(APP, [BareFields, FieldedFields, Fine])).toEqual([
      {
        code: "model-provider.request-fields-missing",
        message:
          "bare-model-provider (BareFields) sets no requestFields — an OpenAI-compatible provider says which request fields it sends: override readonly requestFields = {} (none)",
        nodes: [APP],
      },
    ]);
    expect(providerFieldsViolations(APP, undefined)).toEqual([]);
  });

  it("names a provider whose requestFields is null, and builds no transport to read it", () => {
    expect(providerFieldsViolations(APP, [NullFields]).map((found) => found.message)).toEqual([
      expect.stringContaining("null-fields-model-provider (NullFields) sets no requestFields"),
    ]);
    expect(providerFieldsViolations(APP, [NeedsArguments])).toEqual([]);
  });
});

describe("#1366: providerTimeoutViolations", () => {
  it("names a timeout above the maximum, and not one within it", () => {
    expect(providerTimeoutViolations(APP, [Slow, Fine])).toEqual([
      {
        code: "limits.timeout-invalid",
        message: `slow-model-provider (Slow): ${String(timerProblemOf("timeout", slow, MAX_TIMEOUT))}`,
        nodes: [APP],
      },
    ]);
    expect(providerTimeoutViolations(APP, undefined)).toEqual([]);
  });
});

describe("#1366: providerPriceViolations", () => {
  it("names a price that is no amount from 0, in a listed provider and in a fallback", () => {
    const expected = {
      code: "model.price-invalid",
      message:
        "negative-model-provider (Negative): inputPerMillion is -5, not a finite number of dollars from 0 (usd(...))",
      nodes: [APP],
    };

    expect(providerPriceViolations(APP, [Negative])).toEqual([expected]);
    expect(providerPriceViolations(APP, [OuterOfNegative])).toEqual([expected]);
  });

  it("finds nothing in a zero price, a cost from the response, an empty list or none", () => {
    expect(providerPriceViolations(APP, [Zero, Fine])).toEqual([]);
    expect(providerPriceViolations(APP, [])).toEqual([]);
    expect(providerPriceViolations(APP, undefined)).toEqual([]);
  });
});
