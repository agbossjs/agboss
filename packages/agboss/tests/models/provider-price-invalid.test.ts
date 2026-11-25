/**
 * #1385 — a provider's price table that did not pass `ModelCost.fromPrices` (a literal `ModelCost`, or a table
 * changed after it was made) fails the application's assembly with `[model.price-invalid]`, and at the call
 * the price throws before any cost is recorded. The message names the provider, the field and the value's
 * kind, never a model or a text.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { markedFallbackMessage } from "../../src/models/fallback.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import type { TransportModelProviderOptions } from "../../src/models/model-provider.decorator.js";
import { directoryOf, withProviderPrices } from "../../src/models/workflow-models.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { bedrockApplicationOn } from "./transport/bedrock-apps.fixture.js";
import { answer } from "./transport/bedrock-provider.fixture.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

const options = (name: string, cost: ModelCost): TransportModelProviderOptions => ({
  name,
  description: "A transport with a price table",
  timeout: seconds(5),
  cost,
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
});

const literal = (field: string, value: unknown): ModelCost => ({
  kind: "from-prices",
  prices: {
    "secret/model": { inputPerMillion: usd(1), outputPerMillion: usd(2), [field]: value },
  },
});

@ModelProvider(options("negative-input-model-provider", literal("inputPerMillion", -5)))
class NegativeInputProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider(options("nan-cache-read-model-provider", literal("cacheReadPerMillion", Number.NaN)))
class NanCacheReadProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider(
  options(
    "fine-model-provider",
    ModelCost.fromPrices({ m: { inputPerMillion: usd(0), outputPerMillion: usd(0) } }),
  ),
)
class FineProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider(options("by-response-model-provider", ModelCost.fromResponse()))
class ByResponseProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider({
  ...options("guarded-model-provider", ModelCost.fromResponse()),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
  fallback: NegativeInputProvider,
})
class GuardedProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

describe("#1385: assembly refuses a provider's price that is no amount from 0", () => {
  it("names the provider, the field and the value's kind, never the model", async () => {
    const assembled = applicationOf(
      bedrockApplicationOn({
        name: "negative-price-application",
        providers: [NegativeInputProvider],
      }),
      {},
    );

    await expect(assembled).rejects.toBeInstanceOf(ConfigError.GraphRules);
    await expect(assembled).rejects.toThrow(
      /\[model\.price-invalid\] negative-input-model-provider \(NegativeInputProvider\): inputPerMillion is -5, not a finite number of dollars from 0/,
    );
    await expect(assembled).rejects.not.toThrow(/secret/);
  });

  it("refuses a NaN cached price, and one provider's problem does not hide another's", async () => {
    const assembled = applicationOf(
      bedrockApplicationOn({
        name: "two-bad-application",
        providers: [NegativeInputProvider, NanCacheReadProvider],
      }),
      {},
    );

    await expect(assembled).rejects.toThrow(
      /nan-cache-read-model-provider \(NanCacheReadProvider\): cacheReadPerMillion is NaN,/,
    );
    await expect(assembled).rejects.toThrow(/negative-input-model-provider/);
  });

  it("refuses the table of a breaker's fallback too", async () => {
    const assembled = applicationOf(
      bedrockApplicationOn({ name: "fallback-price-application", providers: [GuardedProvider] }),
      {},
    );

    await expect(assembled).rejects.toThrow(
      /\[model\.price-invalid\] negative-input-model-provider/,
    );
  });

  it("assembles a good table (0 is a price) and a provider that reports its cost", async () => {
    for (const provider of [FineProvider, ByResponseProvider]) {
      await expect(
        applicationOf(
          bedrockApplicationOn({ name: "good-price-application", providers: [provider] }),
          {},
        ),
      ).resolves.toBeDefined();
    }
  });
});

describe("#1385: at run time a bad price throws before any cost is recorded", () => {
  it("the provider prices a model of the config through priceOf: a bad table throws a ConfigError.Unit", () => {
    const config = {
      defaults: { models: {} },
      agents: { a: { model: "bedrock/m", modelProvider: "run-time-model-provider" } },
    } as never;
    const bad: ModelCost = {
      kind: "from-prices",
      prices: { "bedrock/m": { inputPerMillion: -5 as never, outputPerMillion: usd(1) } },
    };

    @ModelProvider(options("run-time-model-provider", bad))
    class RunTimeProvider implements ModelProviderHandler {
      complete(): Promise<ModelProviderResponse> {
        return Promise.resolve(answer("never"));
      }
    }

    expect(() => withProviderPrices(config, directoryOf([RunTimeProvider]))).toThrow(
      ConfigError.Unit,
    );
  });

  it("a fallback's answer is not costed by a bad table", () => {
    const bad: ModelCost = {
      kind: "from-prices",
      prices: { m: { inputPerMillion: -5 as never, outputPerMillion: usd(1) } },
    };
    const message = new AIMessage({
      content: "x",
      usage_metadata: { input_tokens: 100, output_tokens: 1000, total_tokens: 1100 },
    });

    expect(() => markedFallbackMessage(message, { provider: "p", model: "m", cost: bad })).toThrow(
      /\[model\.price-invalid\]/,
    );
  });
});
