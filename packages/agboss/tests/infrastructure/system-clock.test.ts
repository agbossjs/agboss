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
  RandomIdGenerator,
  StoreClock,
  StoreTimeSource,
  pauseThread,
  SystemClock,
  timeoutError,
  timeoutOn,
} from "../../src/infrastructure/clock.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds, type Milliseconds } from "../../src/units/index.js";

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

    const storeClock = new StoreClock(StoreTimeSource.Database, clock);

    expect(storeClock.source).toBe(StoreTimeSource.Database);
    expect(storeClock.now()).toEqual(clock.now());
  });

  it("#847: a store clock a container builds on its own is the application's default: the database's time, the system's clock", () => {
    const storeClock = new StoreClock();

    expect(StoreClock.length).toBe(0);
    expect(storeClock.source).toBe(StoreTimeSource.Database);
    expect(storeClock.now()).toBeInstanceOf(Date);
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

describe("#626: a timeout on the clock", () => {
  it("aborts its signal with its reason once its delay has passed on the clock", async () => {
    const clock = new VirtualClock();
    const reason = new Error("too slow");
    const timeout = timeoutOn(clock, seconds(5), () => reason);

    await clock.advance(seconds(5));

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBe(reason);
  });

  it("released before its delay, never aborts: not at the release, not once the delay has passed", async () => {
    const clock = new VirtualClock();
    const timeout = timeoutOn(clock, seconds(5), timeoutError);

    timeout.release();
    await clock.advance(seconds(1));
    const isAbortedAtRelease = timeout.signal.aborted;
    await clock.advance(seconds(10));

    expect(isAbortedAtRelease).toBe(false);
    expect(timeout.signal.aborted).toBe(false);
  });
});

describe("#911: pauseThread, the one blocking wait (synchronous SQLite startup)", () => {
  it("blocks the thread on Atomics.wait for the delay it is given, and returns", () => {
    const wait = vi.spyOn(Atomics, "wait");

    pauseThread(2);

    expect(wait).toHaveBeenCalledOnce();
    const [array, index, expected, timeout] = wait.mock.calls[0] ?? [];
    expect(array).toBeInstanceOf(Int32Array);
    expect([index, expected, timeout]).toEqual([0, 0, 2]);
  });
});

/** #1141: a delay a Node timer cannot take is waited out in parts, each a timer of its own. */
describe("#1141: SystemClock.sleep splits a delay above the timer's limit", () => {
  const MAX = 2 ** 31 - 1;

  /** The delays of the timers a sleep sets, with the sleep's handle (its timers, in order). */
  function sleeping(delay: number, signal?: AbortSignal) {
    vi.useFakeTimers();
    const set = vi.spyOn(globalThis, "setTimeout");
    let isDone = false;
    void new SystemClock().sleep(delay as Milliseconds, signal).then(() => {
      isDone = true;
    });
    return {
      delays: (): number[] => set.mock.calls.map((call) => Number(call[1])),
      timers: (): { hasRef: () => boolean }[] =>
        set.mock.results.map((result) => result.value as { hasRef: () => boolean }),
      isDone: async (): Promise<boolean> => {
        await vi.advanceTimersByTimeAsync(0);
        return isDone;
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a delay at the limit is one timer, at the limit plus one two: the limit and 1 ms", async () => {
    expect(sleeping(MAX).delays()).toEqual([MAX]);
    await vi.advanceTimersByTimeAsync(MAX);
    vi.useRealTimers();
    expect(sleeping(MAX + 1).delays()).toEqual([MAX]);
    await vi.advanceTimersByTimeAsync(MAX);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("splits into exactly the right parts, the last a rest, never an empty one", async () => {
    const parts = async (delay: number): Promise<number[]> => {
      const sleep = sleeping(delay);
      await vi.advanceTimersByTimeAsync(delay);
      const delays = sleep.delays();
      vi.useRealTimers();
      vi.restoreAllMocks();
      return delays;
    };
    expect(await parts(MAX + 1000)).toEqual([MAX, 1000]);
    expect(await parts(2 * MAX)).toEqual([MAX, MAX]);
    expect(await parts(2 * MAX + 1)).toEqual([MAX, MAX, 1]);
    expect(await parts(5)).toEqual([5]);
  });

  it("the total elapsed time equals the request: not done a millisecond early, done on time", async () => {
    const sleep = sleeping(MAX + 1000);
    await vi.advanceTimersByTimeAsync(MAX + 999);
    expect(await sleep.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sleep.isDone()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort during the first part resolves at once, leaving no timer behind and none set after", async () => {
    const stop = new AbortController();
    const sleep = sleeping(2 * MAX, stop.signal);
    await vi.advanceTimersByTimeAsync(MAX - 1);
    stop.abort();
    expect(await sleep.isDone()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MAX);
    expect(sleep.delays()).toEqual([MAX]);
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  it("an abort during the second part resolves at once, leaving no timer behind", async () => {
    const stop = new AbortController();
    const sleep = sleeping(2 * MAX + 5, stop.signal);
    await vi.advanceTimersByTimeAsync(MAX + 10);
    expect(await sleep.isDone()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    stop.abort();
    expect(await sleep.isDone()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(sleep.delays()).toEqual([MAX, MAX]);
  });

  it("every part's timer leaves the process free to exit", async () => {
    const sleep = sleeping(MAX + 1000);
    await vi.advanceTimersByTimeAsync(MAX);
    expect(sleep.timers()).toHaveLength(2);
    expect(sleep.timers().map((timer) => timer.hasRef())).toEqual([false, false]);
  });

  it("a delay that is no number or below zero fires at once, as a timer does", async () => {
    const sleep = sleeping(Number.NaN);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sleep.isDone()).toBe(true);
    const below = sleeping(-5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await below.isDone()).toBe(true);
  });
});
