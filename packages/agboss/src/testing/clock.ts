import type { Clock } from "../finops/ledger.js";
import type { Timers } from "../infrastructure/timers.js";
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

/**
 * The time of one test, shared by its app instances: fixed at the start, moved only by `advance`.
 * The framework's waits (lease renewals, a resume waiting for a tree's lease) sleep on it.
 */
export interface TestClock {
  readonly now: Clock;
  /**
   * Moves the time forward — `await clock.advance(seconds(31))`, `await app.clock.advance("25h")`:
   * the work already started first reaches its next wait, then the time jumps and every sleep due
   * wakes, in time order, each one's work running before the next. A jump longer than a lease is a
   * holder frozen for that long.
   */
  advance(duration: ClockDuration | Milliseconds): Promise<void>;
}

/** The test's clock with the framework's timers on it (internal: the app instances sleep here). */
export interface VirtualClock extends TestClock {
  readonly timers: Timers;
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

export function createTestClock(start: string = TEST_START): VirtualClock {
  let current = new Date(start).getTime();
  let made = 0;
  const sleepers = new Set<Sleeper>();
  const timers: Timers = {
    sleep: (delay, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        made += 1;
        const sleeper: Sleeper = {
          due: current + delay,
          order: made,
          wake: () => {
            done();
          },
        };
        const done = (): void => {
          sleepers.delete(sleeper);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        sleepers.add(sleeper);
        signal?.addEventListener("abort", done, { once: true });
      }),
  };
  const nextDue = (): Sleeper | undefined =>
    [...sleepers]
      .filter((sleeper) => sleeper.due <= current)
      .sort((first, second) => first.due - second.due || first.order - second.order)[0];
  return {
    now: () => new Date(current),
    timers,
    advance: async (duration) => {
      const distance = millisecondsOf(duration);
      await settle();
      current += distance;
      for (let due = nextDue(); due !== undefined; due = nextDue()) {
        due.wake();
        await settle();
      }
    },
  };
}
