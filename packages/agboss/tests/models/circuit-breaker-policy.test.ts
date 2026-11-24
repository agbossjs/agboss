/**
 * #1313c: the circuit breaker's policy — `fixed` and `exponential`, `failureWindow`, half-open probes —
 * and what the breaker does with it: each open in a row longer, a probe at a time after an open, one
 * success closing it, one failure opening it again.
 */
import { describe, expect, it } from "vitest";
import {
  BreakerBackoff,
  CircuitBreakerPolicy,
  CircuitBreakerPolicyError,
  type FixedCircuitBreakerOptions,
} from "../../src/models/index.js";
import { openDurationOf } from "../../src/models/circuit-breaker-policy.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds, type Milliseconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";

const exponentialOptions = {
  failureThreshold: 1,
  failureWindow: minutes(1),
  initialOpenDuration: seconds(10),
  maxOpenDuration: seconds(35),
  jitter: false,
  halfOpenProbes: 2,
};
const exponential = CircuitBreakerPolicy.exponential(exponentialOptions);

describe("#1313c: CircuitBreakerPolicy", () => {
  it("fixed and exponential are frozen policies that say how they back off", () => {
    const fixed = CircuitBreakerPolicy.fixed({
      failureThreshold: 3,
      failureWindow: minutes(1),
      openDuration: seconds(30),
    });

    expect(fixed.backoff).toBe(BreakerBackoff.Fixed);
    expect(exponential.backoff).toBe(BreakerBackoff.Exponential);
    expect(Object.isFrozen(fixed)).toBe(true);
  });

  it("refuses a value out of range with a CircuitBreakerPolicyError", () => {
    const base: FixedCircuitBreakerOptions = {
      failureThreshold: 1,
      failureWindow: minutes(1),
      openDuration: seconds(1),
    };

    for (const bad of [
      { ...base, failureThreshold: 0 },
      { ...base, failureThreshold: 1.5 },
      { ...base, failureWindow: seconds(0) },
      { ...base, openDuration: -1 as Milliseconds },
      { ...base, openDuration: 999_999_999_999 as Milliseconds },
      { ...base, halfOpenProbes: 0 },
    ]) {
      expect(() => CircuitBreakerPolicy.fixed(bad)).toThrow(CircuitBreakerPolicyError);
    }
    expect(() =>
      CircuitBreakerPolicy.exponential({
        ...exponentialOptions,
        initialOpenDuration: seconds(20),
        maxOpenDuration: seconds(10),
      }),
    ).toThrow(CircuitBreakerPolicyError);
  });

  it("an exponential open doubles from the initial one up to the maximum", () => {
    const lengths = [1, 2, 3, 4].map((streak) => openDurationOf(exponential, streak, () => 0));

    expect(lengths).toEqual([10_000, 20_000, 35_000, 35_000]);
  });

  it("jitter takes a random part of the open: half of it at least", () => {
    const jittery = CircuitBreakerPolicy.exponential({ ...exponentialOptions, jitter: true });

    expect(openDurationOf(jittery, 1, () => 0)).toBe(5_000);
    expect(openDurationOf(jittery, 1, () => 0.5)).toBe(7_500);
  });
});

describe("#1313c: the breaker half-open", () => {
  it("each open in a row lasts longer, and a success closes it for good", async () => {
    const clock = new VirtualClock();
    const breaker = instanceCalls(clock).breakerOf("backoff", exponential);
    await breaker.recordFailure(); // open 1: 10 s
    await clock.advance(seconds(11));
    expect(await breaker.admit()).toBe("probe");
    await breaker.recordFailure(); // the probe failed: open 2: 20 s

    await clock.advance(seconds(15));
    expect(await breaker.state()).toBe("open");
    await clock.advance(seconds(6));
    expect(await breaker.state()).toBe("half-open");
    expect(await breaker.recordSuccess()).toEqual({ from: "half-open", to: "closed" });

    expect(await breaker.state()).toBe("closed");
    expect(await breaker.admit()).toBe("closed");
  });

  it("lets halfOpenProbes calls through at once, the rest are refused", async () => {
    const clock = new VirtualClock();
    const breaker = instanceCalls(clock).breakerOf("probes", exponential);
    await breaker.recordFailure();
    await clock.advance(seconds(11));

    const admitted = [await breaker.admit(), await breaker.admit(), await breaker.admit()];

    expect(admitted).toEqual(["probe", "probe", "refused"]);
  });

  it("a probe that never reports frees its slot after the shortest open", async () => {
    const clock = new VirtualClock();
    const breaker = instanceCalls(clock).breakerOf("lost-probe", exponential);
    await breaker.recordFailure();
    await clock.advance(seconds(11));
    await breaker.admit();
    await breaker.admit();
    expect(await breaker.admit()).toBe("refused");

    await clock.advance(seconds(11));

    expect(await breaker.admit()).toBe("probe");
  });

  it("two instances over one repository agree on it", async () => {
    const clock = new VirtualClock();
    const first = instanceCalls(clock).breakerOf("shared", exponential);
    await first.recordFailure();

    expect(await first.isOpen()).toBe(true);
    expect(await first.admit()).toBe("refused");
  });

  it("a failure told while it is open (a call that began before) does not lengthen the open", async () => {
    const clock = new VirtualClock();
    const breaker = instanceCalls(clock).breakerOf("late", exponential);
    await breaker.recordFailure();

    expect(await breaker.recordFailure()).toBeUndefined();

    await clock.advance(seconds(11));
    expect(await breaker.state()).toBe("half-open");
  });
});
