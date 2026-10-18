import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";

/**
 * The framework's time (#262, infrastructure #261): every time it reads (the ledger's UTC day, the
 * records, `expiresAt` of the leases, `applicationContext.startedAt`) and every wait (lease
 * renewals, the recovery sweep, the shutdown timeout, a tool's and a model call's timeout, retry
 * backoff and `Retry-After` pauses) goes through the application's one `Clock` — never
 * `Date.now()`, `new Date()`, `setTimeout` or `setInterval` directly (lint `agboss/no-direct-time`;
 * this file holds the one real implementation). Tests run on `VirtualClock` (`agboss/testing`),
 * moved by `await clock.advance(seconds(31))` without real waiting. A component that needs the time
 * injects it: `@Injectable({ deps: [Clock] })`.
 */
export abstract class Clock {
  /** The current time. */
  abstract now(): Date;

  /** Resolves after `delay`, or at once when `signal` aborts — it never rejects. */
  abstract sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void>;
}

/**
 * The built-in default: the system's time; a pending sleep does not keep the process alive. An
 * application lists its own clock in `@Application({ providers })` (`FixedClockProvider extends
 * Clock`) only when production needs another time source.
 */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
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
    });
  }
}

/**
 * The system clock for framework code that runs outside an application (a tool or a ledger used
 * on its own, `agboss compare`): what an application would use without a clock of its own.
 */
export const systemClock: Clock = new SystemClock();
