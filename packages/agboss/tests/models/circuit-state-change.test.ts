/**
 * #1343 (#1313): `onCircuitStateChange` — a provider's breaker tells each change of its state: it
 * opens at the threshold, opens again after a failed probe, closes after a successful one.
 */
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const policy = CircuitBreakerPolicy.fixed({
  failureThreshold: 2,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

describe("#1343: the breaker's state changes are told", () => {
  it("opened, then closed by a successful probe; a failure below the threshold is no change", async () => {
    const clock = new VirtualClock();
    const calls = instanceCalls(clock);
    const told: string[] = [];
    calls.observe((provider, { from, to }) => told.push(`${provider}: ${from} -> ${to}`));
    const breaker = calls.breakerOf("told", policy);

    await breaker.recordFailure();
    expect(told).toEqual([]);
    await breaker.recordFailure();
    await clock.advance(seconds(31));
    expect(await breaker.admit()).toBe("probe");
    await breaker.recordSuccess();

    expect(told).toEqual(["told: closed -> open", "told: half-open -> closed"]);
  });

  it("a failed probe opens it again", async () => {
    const clock = new VirtualClock();
    const calls = instanceCalls(clock);
    const told: string[] = [];
    calls.observe((_provider, { from, to }) => told.push(`${from} -> ${to}`));
    const breaker = calls.breakerOf("again", policy);
    await breaker.recordFailure();
    await breaker.recordFailure();
    await clock.advance(seconds(31));
    await breaker.admit();

    await breaker.recordFailure();

    expect(told).toEqual(["closed -> open", "half-open -> open"]);
  });

  it("a listener that throws does not fail the call", async () => {
    const calls = instanceCalls(new VirtualClock());
    calls.observe(() => {
      throw new Error("a bad listener");
    });
    const breaker = calls.breakerOf("bad", policy);
    await breaker.recordFailure();

    await expect(breaker.recordFailure()).resolves.toEqual({ from: "closed", to: "open" });
    expect(await breaker.isOpen()).toBe(true);
  });
});
