import { describe, expect, it } from "vitest";
import {
  ModelFailure,
  OpenRouterDriver,
  QueueBalancingStrategy,
  RateLimitPolicy,
  RetryPolicy,
} from "../../src/models/index.js";
import { secret } from "../../src/environments/secret.js";
import { seconds } from "../../src/units/index.js";

describe("AC6: an OpenRouter driver's routing is typed (compile time)", () => {
  it("AC6: a typo in the routing does not compile", () => {
    const key = secret("OPENROUTER_API_KEY");
    // @ts-expect-error — `provder` is not an OpenRouter option
    const typo = () => OpenRouterDriver({ apiKey: key, provder: { ignore: ["Inceptron"] } });
    // @ts-expect-error — `sort` takes "price" | "throughput" | "latency"
    const wrongValue = () => OpenRouterDriver({ apiKey: key, routing: { sort: "cheapest" } });
    // @ts-expect-error — #395 S8: the TypeScript API is camelCase (`allowFallbacks`)
    const snake = () => OpenRouterDriver({ apiKey: key, routing: { allow_fallbacks: false } });
    const wrongQuantization = () =>
      OpenRouterDriver({
        apiKey: key,
        // @ts-expect-error — `quantizations` takes Quantization members
        routing: { quantizations: ["bf17"] },
      });

    expect([typo, wrongValue, snake, wrongQuantization].every((f) => typeof f === "function")).toBe(
      true,
    );
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
      tenantWeight: () => 2,
    });
    // @ts-expect-error — the balancing strategies are a closed set: an enum, not a string
    const typo = () => RateLimitPolicy.of({ maxConcurrentCalls: 4, balancing: "weighted" });

    expect([typeof bare, typeof fixed, typeof typo]).toEqual(["function", "function", "function"]);
    expect(balanced.balancing).toBe(QueueBalancingStrategy.TenantWeighted);
  });
});
