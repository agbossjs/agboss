/**
 * #533 item 3 — the real clock and its neighbours, as units: `SystemClock.sleep` resolves at once on
 * an aborted signal and when its signal aborts, leaves no timer or listener behind and never keeps
 * the process alive; `monotonicNow()` reads a number that never goes back; the store clock of an
 * instance says it is the database's time; the built-in ids are UUIDs; `timeoutError()` is what
 * `AbortSignal.timeout` aborts with. Nothing is compared with real elapsed time: a sleep is seen
 * resolved, or not, after a few turns of the event loop.
 */
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseStoreClock,
  RandomIdGenerator,
  SystemClock,
  timeoutError,
} from "../../src/infrastructure/clock.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, type Milliseconds } from "../../src/units/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Whether `promise` has settled after the event loop ran a few turns. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let isDone = false;
  const done = (): void => {
    isDone = true;
  };
  void promise.then(done, done);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  return isDone;
}

describe("#533: SystemClock.sleep", () => {
  it("resolves at once when its signal is already aborted", async () => {
    const aborted = AbortSignal.abort();

    await expect(isSettled(new SystemClock().sleep(hours(1), aborted))).resolves.toBe(true);
  });

  it("resolves when its signal aborts, and clears its timer", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const controller = new AbortController();
    const sleeping = new SystemClock().sleep(hours(1), controller.signal);

    controller.abort();

    await expect(isSettled(sleeping)).resolves.toBe(true);
    expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]?.value);
  });

  it("never keeps the process alive: its timer is unref'd", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const sleeping = new SystemClock().sleep(hours(1), controller.signal);

    const timer = timers.mock.results[0]?.value as NodeJS.Timeout;
    const hasRef = timer.hasRef();
    controller.abort();
    await sleeping;

    expect(hasRef).toBe(false);
  });

  it("leaves no listener on its signal once its timer ended it", async () => {
    const controller = new AbortController();

    await new SystemClock().sleep(1 as Milliseconds, controller.signal);

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});

describe("#533: the clock's other parts", () => {
  it("monotonicNow() reads a finite number that never goes back", () => {
    const clock = new SystemClock();

    const first = clock.monotonicNow();
    const second = clock.monotonicNow();

    expect(Number.isFinite(first)).toBe(true);
    expect(second - first).toBeGreaterThanOrEqual(0);
  });

  it("an instance's store clock is the database's time, its now() the clock's", () => {
    const clock = new VirtualClock();

    const storeClock = new DatabaseStoreClock(clock);

    expect(storeClock.isDatabaseTime).toBe(true);
    expect(storeClock.now()).toEqual(clock.now());
  });

  it("the built-in ids are random UUIDs, for executions as for threads", () => {
    const ids = new RandomIdGenerator();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

    const executions = [ids.newExecutionId(), ids.newExecutionId()];

    expect(executions.every((id) => uuid.test(id))).toBe(true);
    expect(executions[0]).not.toBe(executions[1]);
    expect(ids.newThreadId()).toMatch(uuid);
  });

  it("timeoutError() is a TimeoutError DOMException, as AbortSignal.timeout aborts with", () => {
    const error = timeoutError();

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "The operation was aborted due to timeout",
    });
  });
});
