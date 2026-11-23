/**
 * #1366: a retry policy's numbers — the attempts it admits (1 is the least, a fractional or zero count is refused, by
 * both constructors), the longest wait and the wait before a retry of each backoff (jitter between half and the whole
 * of the grown wait), a `None` policy never retried, the failures a provider retries by default.
 */
import { describe, expect, it } from "vitest";
import {
  Backoff,
  ModelFailure,
  RetryPolicy,
  RetryPolicyError,
  TRANSIENT_FAILURES,
} from "../../../src/models/index.js";
import { delayBefore, isRetried, longestWaitOf } from "../../../src/models/retry-policy.js";
import { seconds } from "../../../src/units/index.js";

const exponentialOf = (maxAttempts: number, jitter = false) =>
  RetryPolicy.exponential({
    maxAttempts,
    initialDelay: seconds(1),
    maxDelay: seconds(8),
    jitter,
    retryOn: [ModelFailure.Timeout],
  });
const fixedOf = (maxAttempts: number) =>
  RetryPolicy.fixed({ maxAttempts, delay: seconds(2), retryOn: [ModelFailure.Timeout] });

describe("#1366: the attempts a policy admits", () => {
  it("one attempt is admitted by both constructors, and retried never", () => {
    expect(isRetried(exponentialOf(1), ModelFailure.Timeout, 1)).toBe(false);
    expect(isRetried(fixedOf(1), ModelFailure.Timeout, 1)).toBe(false);
    expect(isRetried(exponentialOf(2), ModelFailure.Timeout, 1)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])("%s attempts are refused by both constructors", (attempts) => {
    expect(() => exponentialOf(attempts)).toThrow(RetryPolicyError);
    expect(() => fixedOf(attempts)).toThrow(RetryPolicyError);
  });

  it("the refusals of one class are told apart by the field they name", () => {
    expect(() => exponentialOf(0)).toThrow(/maxAttempts/);
    expect(() =>
      RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: seconds(5),
        maxDelay: seconds(1),
        jitter: false,
        retryOn: [],
      }),
    ).toThrow(/maxDelay/);
    expect(() =>
      RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: seconds(5),
        maxDelay: seconds(1),
        jitter: false,
        retryOn: [],
      }),
    ).toThrow(RetryPolicyError);
  });

  it("a delay equal to the initial one is admitted", () => {
    expect(
      RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: seconds(5),
        maxDelay: seconds(5),
        jitter: false,
        retryOn: [],
      }).backoff,
    ).toBe(Backoff.Exponential);
  });

  it("a none policy is never retried, whatever else its object carries", () => {
    const carrying = { ...exponentialOf(5), backoff: Backoff.None as const };

    expect(isRetried(carrying, ModelFailure.Timeout, 1)).toBe(false);
    expect(isRetried(RetryPolicy.none(), ModelFailure.Timeout, 1)).toBe(false);
  });
});

describe("#1366: the waits of a policy", () => {
  it("the longest wait of each backoff", () => {
    expect(longestWaitOf(exponentialOf(3))).toBe(seconds(8));
    expect(longestWaitOf(fixedOf(3))).toBe(seconds(2));
    expect(longestWaitOf(RetryPolicy.none())).toBe(0);
  });

  it("the wait before a retry: fixed is the delay, none is nothing, exponential doubles up to its cap", () => {
    expect(delayBefore(fixedOf(3), 2, () => 0)).toBe(seconds(2));
    expect(delayBefore(RetryPolicy.none(), 1, () => 0)).toBe(0);
    const grown = [1, 2, 3, 4, 5].map((retry) => delayBefore(exponentialOf(9), retry, () => 0));
    expect(grown).toEqual([seconds(1), seconds(2), seconds(4), seconds(8), seconds(8)]);
  });

  it("the jitter is from half to the whole of the grown wait, by the random draw", () => {
    const policy = exponentialOf(9, true);

    expect(delayBefore(policy, 3, () => 0)).toBe(seconds(2));
    expect(delayBefore(policy, 3, () => 0.5)).toBe(seconds(3));
    expect(delayBefore(policy, 3, () => 0.999)).toBeCloseTo(seconds(4) * 0.9995, 0);
  });
});

describe("#1366: what a provider retries by default", () => {
  it("timeouts, rate limits and server errors, not network errors", () => {
    expect([...TRANSIENT_FAILURES].sort()).toEqual(
      [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError].sort(),
    );
  });
});
