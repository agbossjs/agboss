import type { Milliseconds } from "../units/index.js";

/**
 * Waiting through the framework's clock (internal; #262 makes the `Clock` contract public): the
 * lease renewals and a resume waiting for a tree's lease sleep here, so a test's virtual clock
 * moves them (`await clock.advance(seconds(31))`) without real waiting.
 */
export interface Timers {
  /** Resolves after `delay`, or at once when `signal` aborts — it never rejects. */
  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void>;
}

/** The system's timers; a pending sleep does not keep the process alive. */
export const systemTimers: Timers = {
  sleep: (delay, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      timer.unref();
      signal?.addEventListener("abort", done, { once: true });
    }),
};
