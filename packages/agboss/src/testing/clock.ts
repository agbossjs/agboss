import { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import { TestSetupError } from "./errors.js";

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

/**
 * The `Clock` of a test (#262): the time is fixed at the start (`TEST_START`, or the given moment)
 * and moves only by `advance`; every framework wait — lease renewals, the recovery sweep, the
 * shutdown timeout, a tool's or a model call's timeout, retry backoff and `Retry-After` pauses —
 * sleeps on it, so a test moves them without real waiting. `testWith` gives one per test as the
 * `clock` fixture (`app.clock` too), shared by the test's instances; a unit test of a component that
 * injects `Clock` passes one to its constructor.
 */
export class VirtualClock extends Clock {
  #current: number;
  #made = 0;
  readonly #sleepers = new Set<Sleeper>();

  constructor(start: Date = new Date(TEST_START)) {
    super();
    this.#current = start.getTime();
  }

  /** The test's current time: its start, plus every `advance` so far. */
  now(): Date {
    return new Date(this.#current);
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
   * wakes, in time order, each one's work running before the next. A jump longer than a lease is a
   * holder frozen for that long.
   */
  async advance(duration: ClockDuration | Milliseconds): Promise<void> {
    const distance = millisecondsOf(duration);
    await settle();
    this.#current += distance;
    for (let due = this.#nextDue(); due !== undefined; due = this.#nextDue()) {
      due.wake();
      await settle();
    }
  }

  /** The earliest sleep due now (the first made, of two due at one moment). */
  #nextDue(): Sleeper | undefined {
    return [...this.#sleepers]
      .filter((sleeper) => sleeper.due <= this.#current)
      .sort((first, second) => first.due - second.due || first.order - second.order)[0];
  }
}
