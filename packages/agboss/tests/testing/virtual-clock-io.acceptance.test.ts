/**
 * #511 AC1, acceptance corner cases of `VirtualClock.advance` waiting for tracked work: a chain of
 * round trips each starting the next, tracked work that sleeps on the clock, the edge of a due
 * time, a tracked failure, and a stuck call failing every later advance by name, never a hang.
 */
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/testing/clock.js";
import { UnsettledWorkError } from "../../src/testing/errors.js";
import { seconds } from "../../src/units/index.js";

/** Real I/O latency: what a database round trip costs (tests may wait for real time). */
const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const NEVER = new Promise<never>(() => undefined);

describe("#511 AC1 acceptance: advance and tracked work", () => {
  it("AC1: a chain of round trips, each tracked by the one before, settles before a due sleep wakes", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    const trip = async (left: number): Promise<void> => {
      await realDelay(5);
      order.push(`trip ${String(left)}`);
      if (left > 1) void clock.track(trip(left - 1));
    };
    void clock.sleep(seconds(1)).then(() => order.push("woken"));
    void clock.track(trip(3));

    await clock.advance(seconds(1));

    expect(order).toEqual(["trip 3", "trip 2", "trip 1", "woken"]);
  });

  it("AC1: tracked work that itself sleeps on the clock is a named UnsettledWorkError, never a hang", async () => {
    // the drain waits for tracked work, and only advance wakes a sleep: a store call must not
    // sleep on the test's clock (none does); the limit fails by name within settleTimeout
    const clock = new VirtualClock(undefined, { settleTimeout: seconds(0.05) });
    void clock.track(clock.sleep(seconds(1)));

    await expect(clock.advance(seconds(5))).rejects.toBeInstanceOf(UnsettledWorkError);
  });

  it("AC1: a sleep due exactly at the jump's end wakes; 1 ms more stays asleep", async () => {
    const clock = new VirtualClock();
    const woken: string[] = [];
    void clock.sleep(seconds(1)).then(() => woken.push("at 1000"));
    void clock.sleep(seconds(1.001)).then(() => woken.push("at 1001"));

    await clock.advance(seconds(1));
    expect(woken).toEqual(["at 1000"]);

    await clock.advance("1ms");
    expect(woken).toEqual(["at 1000", "at 1001"]);
  });

  it("AC1: tracked work that fails after a round trip neither fails nor stalls advance", async () => {
    const clock = new VirtualClock();
    const failing = clock.track(
      (async () => {
        await realDelay(5);
        throw new Error("connection reset");
      })(),
    );
    const caught = failing.catch((error: unknown) => error);

    await expect(clock.advance(seconds(1))).resolves.toBeUndefined();
    expect(await caught).toEqual(new Error("connection reset"));
  });

  it("AC1: one stuck call fails every later advance by name, within settleTimeout", async () => {
    const clock = new VirtualClock(undefined, { settleTimeout: seconds(0.02) });
    void clock.track(NEVER);

    await expect(clock.advance(seconds(1))).rejects.toBeInstanceOf(UnsettledWorkError);
    await expect(clock.advance(seconds(1))).rejects.toMatchObject({ code: "test.unsettled-work" });
  });
});
