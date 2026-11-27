/**
 * #1356 — a rate limit policy (#265, #266): at least one limit, each a whole number from 1, refused as a
 * `ConfigError.RateLimitPolicy` that says which limit it was.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { QueueBalancingStrategy, RateLimitPolicy } from "../../src/models/policies/rate-limit-policy.js";

describe("#1356: the limits of a rate limit policy", () => {
  it("is refused with no limit at all, saying what one needs", () => {
    expect(() => RateLimitPolicy.of({})).toThrow(ConfigError.RateLimitPolicy);
    expect(() => RateLimitPolicy.of({})).toThrow(
      "a rate limit needs maxConcurrentCalls or perMinute.calls / perMinute.tokens",
    );
    expect(() => RateLimitPolicy.of({ perMinute: {} })).toThrow(/needs maxConcurrentCalls/);
  });

  it("refuses each limit that is not a whole number from 1, by its name", () => {
    expect(() => RateLimitPolicy.of({ maxConcurrentCalls: 0 })).toThrow(
      "maxConcurrentCalls must be an integer ≥ 1, got 0",
    );
    expect(() => RateLimitPolicy.of({ perMinute: { calls: 1.5 } })).toThrow(
      "perMinute.calls must be an integer ≥ 1, got 1.5",
    );
    expect(() => RateLimitPolicy.of({ perMinute: { tokens: -3 } })).toThrow(
      "perMinute.tokens must be an integer ≥ 1, got -3",
    );
    expect(() => RateLimitPolicy.of({ maxConcurrentCalls: Number.NaN })).toThrow(/got NaN/);
  });

  it("is a RangeError named and coded, its cause kept", () => {
    const error = ((): unknown => {
      try {
        return RateLimitPolicy.of({ maxConcurrentCalls: 0 });
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError.RateLimitPolicy);
    expect(error).toHaveProperty("name", "ConfigError.RateLimitPolicy");
    expect(error).toHaveProperty("code", "config.rate-limit-policy");
    expect(new ConfigError.RateLimitPolicy({ message: "x", cause: "why" })).toHaveProperty(
      "cause",
      "why",
    );
  });

  it("is a frozen policy of the limits it was given, round-robin by tenant unless told", () => {
    const policy = RateLimitPolicy.of({
      maxConcurrentCalls: 20,
      perMinute: { calls: 500, tokens: 400_000 },
    });

    expect(policy).toMatchObject({
      maxConcurrentCalls: 20,
      perMinute: { calls: 500, tokens: 400_000 },
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.perMinute)).toBe(true);
  });
});

describe("#1356: the balancing and the weight of a rate limit policy go together", () => {
  const caught = (make: () => unknown): unknown => {
    try {
      make();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("TenantWeighted without a tenantWeight is a ConfigError.RateLimitPolicy that names what it needs", () => {
    const error = caught(() =>
      RateLimitPolicy.of({
        maxConcurrentCalls: 2,
        balancing: QueueBalancingStrategy.TenantWeighted,
      }),
    );

    expect(error).toBeInstanceOf(ConfigError.RateLimitPolicy);
    expect(error).toHaveProperty(
      "message",
      "QueueBalancingStrategy.TenantWeighted needs tenantWeight: (tenant) => number",
    );
  });

  it.each([
    QueueBalancingStrategy.TenantRoundRobin,
    QueueBalancingStrategy.TenantLeastInFlight,
    QueueBalancingStrategy.Fifo,
  ])("a tenantWeight with %s is refused: it is read only with TenantWeighted", (balancing) => {
    const error = caught(() =>
      RateLimitPolicy.of({ maxConcurrentCalls: 2, balancing, tenantWeight: () => 2 }),
    );

    expect(error).toBeInstanceOf(ConfigError.RateLimitPolicy);
    expect(error).toHaveProperty(
      "message",
      "tenantWeight is read only with QueueBalancingStrategy.TenantWeighted",
    );
  });

  it("a tenantWeight with no balancing is refused too: the default is round-robin", () => {
    expect(() => RateLimitPolicy.of({ maxConcurrentCalls: 2, tenantWeight: () => 2 })).toThrow(
      "tenantWeight is read only with QueueBalancingStrategy.TenantWeighted",
    );
  });

  it("TenantWeighted with its tenantWeight keeps both; any other strategy has no weight", () => {
    const weight = (): number => 3;
    const weighted = RateLimitPolicy.of({
      maxConcurrentCalls: 2,
      balancing: QueueBalancingStrategy.TenantWeighted,
      tenantWeight: weight,
    });
    const plain = RateLimitPolicy.of({ maxConcurrentCalls: 2 });
    const fifo = RateLimitPolicy.of({ maxConcurrentCalls: 2, balancing: QueueBalancingStrategy.Fifo });

    expect(weighted.balancing).toBe(QueueBalancingStrategy.TenantWeighted);
    expect(weighted.tenantWeight).toBe(weight);
    expect(plain.balancing).toBe(QueueBalancingStrategy.TenantRoundRobin);
    expect(plain.tenantWeight).toBeUndefined();
    expect(fifo.balancing).toBe("fifo");
  });

  it("keeps each limit as given and leaves the unset ones undefined", () => {
    const calls = RateLimitPolicy.of({ perMinute: { calls: 7 } });
    const tokens = RateLimitPolicy.of({ perMinute: { tokens: 9 } });

    expect(calls.maxConcurrentCalls).toBeUndefined();
    expect(calls.perMinute).toEqual({ calls: 7 });
    expect(tokens.perMinute).toEqual({ tokens: 9 });
    expect(RateLimitPolicy.of({ maxConcurrentCalls: 1 }).perMinute).toEqual({});
  });

  it("accepts the limit of 1 and refuses the limit just below it, whatever its kind", () => {
    expect(RateLimitPolicy.of({ maxConcurrentCalls: 1 }).maxConcurrentCalls).toBe(1);
    expect(() => RateLimitPolicy.of({ perMinute: { calls: 0 } })).toThrow(
      "perMinute.calls must be an integer ≥ 1, got 0",
    );
    expect(() => RateLimitPolicy.of({ perMinute: { tokens: 0 } })).toThrow(
      "perMinute.tokens must be an integer ≥ 1, got 0",
    );
  });
});
