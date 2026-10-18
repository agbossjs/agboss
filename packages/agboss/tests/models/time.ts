import { Clock } from "../../src/infrastructure/clock.js";
import type { Milliseconds } from "../../src/units/index.js";
import { seconds } from "../../src/units/index.js";

/** A short duration for tests (the public units start at seconds). */
export const milliseconds = (amount: number): Milliseconds => seconds(amount / 1000);

/**
 * A clock that stands still at the epoch and records the waits between attempts: a plain sleep
 * (a retry wait, a `Retry-After`) is recorded and passes at once; a timer — a sleep with a signal,
 * like a request's timeout — never fires, since no time passes.
 */
export class InstantClock extends Clock {
  readonly waits: number[] = [];

  now(): Date {
    return new Date(0);
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
    }
    this.waits.push(delay);
    return Promise.resolve();
  }
}
