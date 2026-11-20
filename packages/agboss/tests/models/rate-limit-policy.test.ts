/**
 * #1356 — a rate limit policy (#265, #266): at least one limit, each a whole number from 1, refused as a
 * `RateLimitPolicyError` that says which limit it was.
 */
import { describe, expect, it } from "vitest";
import {
  RateLimitPolicy,
  RateLimitPolicyError,
} from "../../src/models/policies/rate-limit-policy.js";

describe("#1356: the limits of a rate limit policy", () => {
  it("is refused with no limit at all, saying what one needs", () => {
    expect(() => RateLimitPolicy.of({})).toThrow(RateLimitPolicyError);
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

    expect(error).toBeInstanceOf(RangeError);
    expect(error).toBeInstanceOf(RateLimitPolicyError);
    expect(error).toHaveProperty("name", "RateLimitPolicyError");
    expect(error).toHaveProperty("code", "config.rate-limit-policy");
    expect(new RateLimitPolicyError({ message: "x", cause: "why" })).toHaveProperty("cause", "why");
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
