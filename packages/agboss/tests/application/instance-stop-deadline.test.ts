/**
 * #1366: the end of an instance's graceful stop is the earliest of the ends its `close({ timeout })` calls set — a later,
 * longer timeout never pushes back an earlier, shorter one — so an instance always ends within the timeout it was given.
 */
import { ComponentOptions } from "../../src/components/component-options.js";
import { describe, expect, it } from "vitest";
import { instancePartsOf } from "../../src/application/instance-steps.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

async function stopOf(clock: VirtualClock) {
  const assembled = {
    maxConcurrentSteps: undefined,
    compensationTimeout: 1,
    providers: [],
    componentOptions: ComponentOptions.none,
  };
  const log = { warn: () => undefined };
  const stores = {
    executionTrees: {},
    childQueue: {},
    rateLimits: {},
    pausedExecutions: {},
  };
  const parts = await instancePartsOf(assembled as never, clock, log as never, stores as never, {
    application: { instanceId: "instance" },
  });
  return parts.stepsAtStop;
}

describe("#1366: the stop's end is the earliest of the timeouts given", () => {
  it("a later close with a longer timeout does not push the end back", async () => {
    const clock = new VirtualClock();
    const stop = await stopOf(clock);

    stop.endBy(seconds(10));
    stop.endBy(seconds(60));
    await clock.advance(seconds(11));

    expect(stop.signal.aborted).toBe(true);
  });

  it("a later close with an equal timeout leaves the end where it was", async () => {
    const clock = new VirtualClock();
    const stop = await stopOf(clock);

    stop.endBy(seconds(10));
    await clock.advance(seconds(4));
    stop.endBy(seconds(6));
    await clock.advance(seconds(6));

    expect(stop.signal.aborted).toBe(true);
  });

  it("a later close with a shorter one moves it earlier", async () => {
    const clock = new VirtualClock();
    const stop = await stopOf(clock);

    stop.endBy(seconds(60));
    stop.endBy(seconds(5));
    await clock.advance(seconds(6));

    expect(stop.signal.aborted).toBe(true);
  });

  it("a stop with no time ends at once", async () => {
    const stop = await stopOf(new VirtualClock());

    stop.endBy(seconds(0));

    expect(stop.signal.aborted).toBe(true);
  });
});
