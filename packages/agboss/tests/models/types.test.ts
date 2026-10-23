import { describe, expect, it } from "vitest";
import {
  ModelFailure,
  OpenRouterProvider,
  QueueBalancingStrategy,
  RateLimitPolicy,
  RetryPolicy,
  type OpenRouterFields,
} from "../../src/models/index.js";
import { seconds } from "../../src/units/index.js";

describe("AC6: requestFields are typed per provider (compile time)", () => {
  it("AC6: a typo in a provider's request fields does not compile", () => {
    abstract class Typo extends OpenRouterProvider {
      // @ts-expect-error — `provder` is not an OpenRouter request field
      override readonly requestFields: OpenRouterFields = { provder: { ignore: ["Inceptron"] } };
    }
    abstract class WrongValue extends OpenRouterProvider {
      // @ts-expect-error — `sort` takes "price" | "throughput" | "latency"
      override readonly requestFields: OpenRouterFields = { provider: { sort: "cheapest" } };
    }

    abstract class SnakeCase extends OpenRouterProvider {
      // @ts-expect-error — #395 S8: the TypeScript API is camelCase (`allowFallbacks`)
      override readonly requestFields: OpenRouterFields = { provider: { allow_fallbacks: false } };
    }
    abstract class WrongQuantization extends OpenRouterProvider {
      // @ts-expect-error — `quantizations` takes Quantization members
      override readonly requestFields: OpenRouterFields = { provider: { quantizations: ["bf17"] } };
    }

    expect([Typo.name, WrongValue.name, SnakeCase.name, WrongQuantization.name]).toEqual([
      "Typo",
      "WrongValue",
      "SnakeCase",
      "WrongQuantization",
    ]);
  });

  it("AC6: retry policies have required fields", () => {
    // @ts-expect-error — an exponential policy needs maxDelay, jitter and retryOn
    const partial = () => RetryPolicy.exponential({ maxAttempts: 3, initialDelay: seconds(1) });
    const fixed = RetryPolicy.fixed({
      maxAttempts: 2,
      delay: seconds(1),
      retryOn: [ModelFailure.RateLimited],
    });

    expect(typeof partial).toBe("function");
    expect(fixed.backoff).toBe("fixed");
  });
});

describe("#266 AC9: timeouts and delays are values with units", () => {
  it("bare numbers do not compile", () => {
    const bare = () =>
      RetryPolicy.exponential({
        maxAttempts: 3,
        // @ts-expect-error — a delay is seconds(…) / minutes(…), never a bare number
        initialDelay: 1000,
        maxDelay: seconds(20),
        jitter: true,
        retryOn: [ModelFailure.RateLimited],
      });
    const fixed = () =>
      // @ts-expect-error — so is a fixed delay
      RetryPolicy.fixed({ maxAttempts: 2, delay: 500, retryOn: [ModelFailure.Timeout] });
    const balanced = RateLimitPolicy.of({
      maxConcurrentCalls: 4,
      balancing: QueueBalancingStrategy.TenantWeighted,
    });
    // @ts-expect-error — the balancing strategies are a closed set: an enum, not a string
    const typo = () => RateLimitPolicy.of({ maxConcurrentCalls: 4, balancing: "weighted" });

    expect([typeof bare, typeof fixed, typeof typo]).toEqual(["function", "function", "function"]);
    expect(balanced.balancing).toBe(QueueBalancingStrategy.TenantWeighted);
  });
});
