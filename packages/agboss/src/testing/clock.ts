import { Clock, SystemClock } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { TestSetupError, UnsettledWorkError } from "./errors.js";

/** A duration with its unit: `"500ms"`, `"30s"`, `"5m"`, `"25h"`, `"2d"`. */
export type ClockDuration = `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const isUnit = (unit: string): unit is keyof typeof UNIT_MS => Object.hasOwn(UNIT_MS, unit);

/** Milliseconds of a duration. */
export function millisecondsOf(duration: ClockDuration | Milliseconds): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration);
  const unit = match?.[2] ?? "";
  if (match === null || !isUnit(unit)) {
    throw new TestSetupError(`Not a duration: "${duration}" (e.g. "30s", "25h")`);
  }
  return Number(match[1]) * UNIT_MS[unit];
}

/** Every test starts at the same moment, so runs and days are reproducible. */
export const TEST_START = "2026-01-05T09:00:00.000Z";

interface Sleeper {
  readonly due: number;
  readonly order: number;
  readonly wake: () => void;
}

/** Lets the work a woken sleep scheduled run before the next one wakes. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The real time `advance` waits for tracked work to settle, at most (#511). */
const SETTLE_TIMEOUT = seconds(2);

/** The real clock the bound on tracked work reads: a test's own time never moves by itself. */
const REAL_TIME = new SystemClock();

/** Options of a test's clock. */
export interface VirtualClockOptions {
  /**
   * How long, in real time, `advance` waits for the tracked work in flight to settle before it
   * fails with `UnsettledWorkError` (default 2 s).
   */
  readonly settleTimeout?: Milliseconds;
}

/**
 * The `Clock` of a test (#262): the time is fixed at the start (`TEST_START`, or the given moment)
 * and moves only by `advance`; every framework wait — lease renewals, the recovery sweep, the
 * shutdown timeout, a tool's or a model call's timeout, retry backoff and `Retry-After` pauses —
 * sleeps on it, so a test moves them without real waiting. `testWith` gives one per test as the
 * `clock` fixture (`app.clock` too), shared by the test's instances; a unit test of a component that
 * injects `Clock` passes one to its constructor. `testWith` always runs on it, even when the
 * application lists its own `Clock`: tests never run on real time.
 */
export class VirtualClock extends Clock {
  #current: number;
  #made = 0;
  readonly #sleepers = new Set<Sleeper>();
  /** Tracked work not settled yet (#511), as promises that never reject. */
  readonly #inFlight = new Set<Promise<void>>();
  readonly #settleTimeout: Milliseconds;

  constructor(start: Date = new Date(TEST_START), options: VirtualClockOptions = {}) {
    super();
    this.#current = start.getTime();
    this.#settleTimeout = options.settleTimeout ?? SETTLE_TIMEOUT;
  }

  /**
   * Work `advance` waits for before it moves the time and after each sleep it wakes (#511): a
   * store's round trip to a database, which one turn of the event loop does not finish. The
   * published contract suites track every store call of their targets; returns `work` as it is.
   */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlight.add(settled);
    void settled.then(() => this.#inFlight.delete(settled));
    return work;
  }

  /** The test's current time: its start, plus every `advance` so far. */
  now(): Date {
    return new Date(this.#current);
  }

  /** Its monotonic time is its own (#533): it moves only by `advance`, as `now()` does. */
  override monotonicNow(): number {
    return this.#current;
  }

  /** Resolves when an `advance` reaches `delay` from now, or at once when `signal` aborts. */
  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      this.#made += 1;
      const sleeper: Sleeper = {
        due: this.#current + delay,
        order: this.#made,
        wake: () => {
          done();
        },
      };
      const done = (): void => {
        this.#sleepers.delete(sleeper);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.#sleepers.add(sleeper);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Moves the time forward — `await clock.advance(seconds(31))`, `await app.clock.advance("25h")`:
   * the work already started first reaches its next wait, then the time jumps and every sleep due
   * wakes, in time order, each one's work running before the next — the work `track`ed included,
   * up to `settleTimeout` of real time (#511). A jump longer than a lease is a holder frozen for
   * that long.
   */
  async advance(duration: ClockDuration | Milliseconds): Promise<void> {
    const distance = millisecondsOf(duration);
    await this.#settled();
    this.#current += distance;
    for (let due = this.#nextDue(); due !== undefined; due = this.#nextDue()) {
      due.wake();
      await this.#settled();
    }
  }

  /** One turn of the event loop, then until no tracked work is in flight (a settled call may start the next). */
  async #settled(): Promise<void> {
    await settle();
    while (this.#inFlight.size > 0) {
      await this.#drained();
      await settle();
    }
  }

  /** The tracked work in flight now, settled — or `UnsettledWorkError` after `settleTimeout`. */
  async #drained(): Promise<void> {
    const timer = new AbortController();
    const inFlight = [...this.#inFlight];
    const isSettled = await Promise.race([
      Promise.all(inFlight).then(() => true),
      REAL_TIME.sleep(this.#settleTimeout, timer.signal).then(() => false),
    ]);
    timer.abort();
    if (!isSettled) throw new UnsettledWorkError(this.#inFlight.size, this.#settleTimeout);
  }

  /** The earliest sleep due now (the first made, of two due at one moment). */
  #nextDue(): Sleeper | undefined {
    return [...this.#sleepers]
      .filter((sleeper) => sleeper.due <= this.#current)
      .sort((first, second) => first.due - second.due || first.order - second.order)[0];
  }
}
