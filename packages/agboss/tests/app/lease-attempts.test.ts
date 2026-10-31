/**
 * #508 re-review — the outbound calls' attempts in flight under a held lease (`LeaseAttempts`): its
 * release waits for them only within their bounds (HIGH1), and a lease is never yielded while one
 * runs (MEDIUM3), the exact interleaving of a step that ended with its attempt still sending while
 * a caller waits for remote children.
 */
import { describe, expect, it } from "vitest";
import { LeaseAttempts, LeaseYields } from "../../src/app/lease-yields.js";
import { VirtualClock } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";

/** An attempt that settles when told. */
function attemptInFlight(): { readonly attempt: Promise<void>; readonly settle: () => void } {
  let settle = (): void => undefined;
  const attempt = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { attempt, settle };
}

const noStep = (): Promise<() => void> => Promise.resolve(() => undefined);

/** Lets every microtask and immediate run. */
const flushed = () => new Promise((resolve) => setImmediate(resolve));

describe("#508 re-review HIGH1: a release waits for its attempts within their bounds", () => {
  it("no attempt: settled at once", async () => {
    const attempts = new LeaseAttempts(new VirtualClock());

    expect(await attempts.settled(new AbortController().signal)).toBe(true);
  });

  it("an attempt that settles before its timeout: settled, true", async () => {
    const clock = new VirtualClock();
    const attempts = new LeaseAttempts(clock);
    const { attempt, settle } = attemptInFlight();
    attempts.keep(attempt, minutes(2), noStep);

    const settled = attempts.settled(new AbortController().signal);
    settle();

    expect(await settled).toBe(true);
  });

  it("an attempt that never settles: the wait ends at its timeout, false — never hung", async () => {
    const clock = new VirtualClock();
    const attempts = new LeaseAttempts(clock);
    attempts.keep(attemptInFlight().attempt, minutes(2), noStep);
    let isSettled: boolean | undefined;
    void attempts.settled(new AbortController().signal).then((value) => (isSettled = value));

    await clock.advance(seconds(119));
    await flushed();
    const before = isSettled;
    await clock.advance(seconds(1));
    await flushed();

    expect(before).toBeUndefined();
    expect(isSettled).toBe(false);
  });

  it("an attempt that never settles: a lost lease or the instance's stop ends the wait at once, false", async () => {
    const attempts = new LeaseAttempts(new VirtualClock());
    attempts.keep(attemptInFlight().attempt, minutes(2), noStep);
    const [lost, stopping] = [new AbortController(), new AbortController()];

    const byLoss = attempts.settled(lost.signal);
    lost.abort();
    const byStop = attempts.settled(new AbortController().signal, stopping.signal);
    stopping.abort();

    expect(await byLoss).toBe(false);
    expect(await byStop).toBe(false);
  });

  it("an attempt that throws counts as settled", async () => {
    const attempts = new LeaseAttempts(new VirtualClock());
    const failed = Promise.reject(new Error("declined"));
    attempts.keep(failed, minutes(2), noStep);

    expect(await attempts.settled(new AbortController().signal)).toBe(true);
  });
});

describe("#508 re-review MEDIUM3 / final N5: a live attempt blocks a yield — within its bound", () => {
  it("a step ended with its attempt still sending while a caller waits for remote children: the lease is held until the attempt settled, then yielded", async () => {
    const moves: boolean[] = [];
    const yields = new LeaseYields((shouldYield) => {
      moves.push(shouldYield);
      return Promise.resolve();
    });
    const attempts = new LeaseAttempts(new VirtualClock());
    const leaveStep = await yields.enterStep();
    const { attempt, settle } = attemptInFlight();
    attempts.keep(attempt, minutes(2), () => yields.enterStep());
    await flushed();

    leaveStep();
    await yields.startWaiting();
    await flushed();
    const whileSending = [...moves];
    settle();
    await flushed();

    expect(whileSending.every((shouldYield) => !shouldYield)).toBe(true);
    expect(moves.at(-1)).toBe(true);
  });

  it("a send that never returns holds the yield back only until its attemptTimeout: then the lease is yielded", async () => {
    const moves: boolean[] = [];
    const yields = new LeaseYields((shouldYield) => {
      moves.push(shouldYield);
      return Promise.resolve();
    });
    const clock = new VirtualClock();
    const attempts = new LeaseAttempts(clock);
    const leaveStep = await yields.enterStep();
    attempts.keep(attemptInFlight().attempt, minutes(2), () => yields.enterStep());
    await flushed();
    leaveStep();
    await yields.startWaiting();

    await clock.advance("119999ms");
    await flushed();
    const beforeBound = [...moves];
    await clock.advance("1ms");
    await flushed();

    expect(beforeBound.every((shouldYield) => !shouldYield)).toBe(true);
    expect(moves.at(-1)).toBe(true);
  });
});
