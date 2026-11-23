/**
 * #1366: a quorum's deadline — computed at dispatch as the moment plus the span, reached when the clock is at it,
 * moved by the time the launch's branches waited in the tree's queue and watched until it expires or the launch is
 * decided; a sleep to the deadline is never given a negative span, though the clock moved on between two reads.
 */
import { describe, expect, it } from "vitest";
import {
  deadlineAtOf,
  hasExpired,
  QueueTime,
  watchDeadline,
} from "../../../src/flow/runtime/launch/deadline.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";

describe("#1366: the moment a quorum's deadline falls", () => {
  it("is the dispatch's moment plus the deadline", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(deadlineAtOf(now, seconds(30))).toBe(now.getTime() + seconds(30));
  });

  it("has passed when the clock is at it, not a millisecond before", async () => {
    const clock = new VirtualClock();
    const at = clock.now().getTime() + seconds(5);

    expect(hasExpired(clock, at)).toBe(false);
    await clock.advance((seconds(5) - 1) as Milliseconds);
    expect(hasExpired(clock, at)).toBe(false);
    await clock.advance(1 as Milliseconds);

    expect(hasExpired(clock, at)).toBe(true);
  });
});

describe("#1366: watching a deadline", () => {
  it("expires at the deadline on the clock, not before", async () => {
    const clock = new VirtualClock();
    let expired = 0;
    watchDeadline(
      clock,
      clock.now().getTime() + seconds(10),
      new AbortController().signal,
      new QueueTime(clock),
      () => {
        expired += 1;
      },
    );

    await clock.advance(seconds(9));
    expect(expired).toBe(0);
    await clock.advance(seconds(2));

    expect(expired).toBe(1);
  });

  it("is moved by the time the branches waited in the queue, and never runs while they wait", async () => {
    const clock = new VirtualClock();
    const queued = new QueueTime(clock);
    let expired = 0;
    watchDeadline(
      clock,
      clock.now().getTime() + seconds(10),
      new AbortController().signal,
      queued,
      () => {
        expired += 1;
      },
    );
    await clock.advance(seconds(4));
    queued.enter(); // 4 s in: the branches wait for a slot
    await clock.advance(seconds(30));
    expect(expired).toBe(0); // the deadline passed on the wall clock, but they still wait
    queued.leave();
    expect(queued.excluded()).toBe(seconds(30));

    await clock.advance(seconds(5));
    expect(expired).toBe(0); // 4 s + 5 s of the 10 s
    await clock.advance(seconds(2));

    expect(expired).toBe(1);
  });

  it("does not expire a launch that was decided first", async () => {
    const clock = new VirtualClock();
    const decided = new AbortController();
    let expired = 0;
    watchDeadline(
      clock,
      clock.now().getTime() + seconds(10),
      decided.signal,
      new QueueTime(clock),
      () => {
        expired += 1;
      },
    );

    decided.abort();
    await clock.advance(seconds(20));

    expect(expired).toBe(0);
  });

  it("never sleeps a negative span, though the clock moved on between its two reads", async () => {
    const slept: number[] = [];
    // the first read is a millisecond before the deadline, the next (the span to it) is past it
    const reads = [999, 1005, 1005, 1005];
    const clock = {
      now: () => new Date(reads.shift() ?? 1005),
      sleep: (delay: Milliseconds) => {
        slept.push(delay);
        return Promise.resolve();
      },
    };
    let expired = 0;

    watchDeadline(
      clock as never,
      1000,
      new AbortController().signal,
      new QueueTime(clock as never),
      () => {
        expired += 1;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(slept).toEqual([0]);
    expect(expired).toBe(1);
  });
});
