/**
 * #1366: what the circuit breaker counts — each failed call within the window, the threshold opening it for
 * `openFor` and starting its count anew, a success forgetting the failures so far.
 */
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";

const policy = { failureThreshold: 2, window: minutes(1), openFor: seconds(30) };

const breakerOn = (clock: VirtualClock) => instanceCalls(clock).breakerOf("counted", policy);

describe("#1366: the breaker's count", () => {
  it("counts one failure per failed call: a failure below the threshold leaves it closed, the threshold opens it", async () => {
    const breaker = breakerOn(new VirtualClock());

    await breaker.recordFailure();
    expect(await breaker.isOpen()).toBe(false);
    await breaker.recordFailure();

    expect(await breaker.isOpen()).toBe(true);
  });

  it("stays open for openFor, and closes on the clock after it", async () => {
    const clock = new VirtualClock();
    const breaker = breakerOn(clock);
    await breaker.recordFailure();
    await breaker.recordFailure();

    await clock.advance(seconds(29));
    expect(await breaker.isOpen()).toBe(true);
    await clock.advance(seconds(2));

    expect(await breaker.isOpen()).toBe(false);
  });

  it("starts its count anew when it opens: one failure after it closed does not open it again", async () => {
    const clock = new VirtualClock();
    const breaker = breakerOn(clock);
    await breaker.recordFailure();
    await breaker.recordFailure();
    await clock.advance(seconds(31));

    await breaker.recordFailure();

    expect(await breaker.isOpen()).toBe(false);
  });

  it("forgets the failures so far on a success", async () => {
    const breaker = breakerOn(new VirtualClock());
    await breaker.recordFailure();

    await breaker.recordSuccess();
    await breaker.recordFailure();

    expect(await breaker.isOpen()).toBe(false);
  });
});
