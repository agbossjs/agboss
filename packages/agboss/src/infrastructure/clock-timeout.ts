import type { Milliseconds } from "../units/index.js";
import type { Clock } from "./clock.js";

/** A timeout on a clock: its signal, and its release once the work it guards has ended. */
export interface ClockTimeout {
  /** Aborted with the timeout's reason once `delay` has passed on the clock (unless released). */
  readonly signal: AbortSignal;
  /** Stops the timer: the signal never aborts after this. */
  readonly release: () => void;
}

/**
 * A timer on the framework's clock instead of `AbortSignal.timeout` / `setTimeout` (#262): the
 * signal aborts with `reason()` after `delay`, so a test's `clock.advance(…)` moves it.
 */
export function timeoutOn(clock: Clock, delay: Milliseconds, reason: () => Error): ClockTimeout {
  const timeout = new AbortController();
  const released = new AbortController();
  void clock.sleep(delay, released.signal).then(() => {
    if (!released.signal.aborted) timeout.abort(reason());
  });
  return {
    signal: timeout.signal,
    release: () => {
      released.abort();
    },
  };
}

/** What `AbortSignal.timeout` aborts with: a `TimeoutError`, read as `ModelFailure.Timeout`. */
export const timeoutError = (): Error =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

/**
 * A computed wait (a retry delay, a `Retry-After`) as a duration: the brand is applied here, once,
 * to a finite number of milliseconds ≥ 0.
 */
export const waitOf = (amount: number): Milliseconds => Math.max(0, amount) as Milliseconds;
