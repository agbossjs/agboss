import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import type { Milliseconds } from "../../../units/index.js";

/**
 * Real-time bound of the explorer's actions (#928): the run's own clock never advances while an
 * action waits, so one loop of the process counts each pending action's real time — a timer per
 * action would cost half again the explorer's run (a million actions) for a bound that only a hung
 * store ever meets.
 */

/** How often the loop looks at what is pending. */
const LOOK_EVERY: Milliseconds = waitOf(50);

/** An action in flight: when it started, how long it may take, how it fails. */
interface Pending {
  readonly since: number;
  readonly bound: Milliseconds;
  /** The action's own description of its timeout. */
  readonly timedOut: () => Error;
  readonly fail: (error: Error) => void;
}

/** The actions in flight in this process and the loop that watches them while there are any. */
export class ActionWatchdog {
  readonly #pending = new Set<Pending>();
  #isLooking = false;

  /** `work` as it ends, or `timedOut()` once it ran past `bound` of real time. */
  watch<T>(work: Promise<T>, bound: Milliseconds, timedOut: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        since: systemClock.monotonicNow(),
        bound,
        timedOut,
        fail: (error) => {
          reject(error);
        },
      };
      this.#pending.add(pending);
      void this.#look();
      work.then(
        (value) => {
          this.#pending.delete(pending);
          resolve(value);
        },
        (error: unknown) => {
          this.#pending.delete(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #look(): Promise<void> {
    if (this.#isLooking) return;
    this.#isLooking = true;
    while (this.#pending.size > 0) {
      await systemClock.sleep(LOOK_EVERY);
      const now = systemClock.monotonicNow();
      for (const pending of this.#pending)
        if (now - pending.since >= pending.bound) {
          this.#pending.delete(pending);
          pending.fail(pending.timedOut());
        }
    }
    this.#isLooking = false;
  }
}

/** The one watchdog of the process. */
export const actionWatchdog = new ActionWatchdog();
