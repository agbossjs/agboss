import { randomUUID } from "node:crypto";
import { Injectable } from "../components/decorators.js";
import type { Milliseconds } from "../units/index.js";

/**
 * The framework's time (#262, infrastructure #261): every time it reads (the ledger's UTC day, the
 * records, `expiresAt` of the leases, `applicationContext.startedAt`) and every wait (lease
 * renewals, the recovery sweep, the shutdown timeout, a tool's and a model call's timeout, retry
 * backoff and `Retry-After` pauses) goes through the application's one `Clock` — never
 * `Date.now()`, `new Date()`, `setTimeout` or `setInterval` directly (lint `agboss/no-direct-time`;
 * this file holds the one real implementation). Tests run on `VirtualClock` (`@agboss/core/testing`),
 * moved by `await clock.advance(seconds(31))` without real waiting. A component that needs the time
 * injects it: `@Injectable({ deps: [Clock] })`.
 */
export abstract class Clock {
  /** The current time. */
  abstract now(): Date;

  /** Resolves after `delay`, or at once when `signal` aborts — it never rejects. */
  abstract sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void>;

  /**
   * Milliseconds on a clock that never jumps (#533), from an arbitrary origin — only the difference
   * of two readings means anything: the elapsed time a lease's holder fences itself with, never its
   * wall clock, so an offset or a step of the wall clock does not move its fence. The default reads
   * `now()`; a clock of your own that can be set back overrides it.
   */
  monotonicNow(): number {
    return this.now().getTime();
  }
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

  /** The process's monotonic clock (`performance.now()`): steps of the wall clock never move it. */
  override monotonicNow(): number {
    return performance.now();
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
 * The time a store decides a lease's expiry by (#533) — a seam, never listed. In production
 * (`isDatabaseTime`) a networked store reads its database's own time inside each statement that
 * takes, renews, fences or closes a lease (PostgreSQL's `clock_timestamp()`), so every instance
 * agrees on the instant of expiry whatever its wall clock says; the in-memory and SQLite stores, on
 * one host, read `now()` — the application's clock. A test injects its clock instead
 * (`isDatabaseTime` false: every store reads `now()`), so `clock.advance` crosses an expiry. A store
 * takes it in its `deps`: `@Injectable({ deps: [PostgresConnection, StoreClock, ApplicationContext] })`.
 */
export abstract class StoreClock {
  /** Whether a networked store reads its database's time (production) rather than `now()`. */
  abstract readonly isDatabaseTime: boolean;

  /** The time of a store that has no clock of its own (in-memory, SQLite), and of every store in a test. */
  abstract now(): Date;
}

/** The store clock of an application instance: the database's time, the host's clock for a store on it. */
export class DatabaseStoreClock extends StoreClock {
  readonly isDatabaseTime: boolean = true;

  constructor(private readonly clock: Pick<Clock, "now">) {
    super();
  }

  now(): Date {
    return this.clock.now();
  }
}

/** A test's store clock (#533): every store, networked or not, decides by the test's clock. */
export class TestStoreClock extends StoreClock {
  readonly isDatabaseTime: boolean = false;

  constructor(private readonly clock: Pick<Clock, "now">) {
    super();
  }

  now(): Date {
    return this.clock.now();
  }
}

/**
 * The system clock for framework code that runs outside an application (a tool or a ledger used
 * on its own, `agboss compare`): what an application would use without a clock of its own.
 */
export const systemClock: Clock = new SystemClock();

/**
 * The ids the framework mints (#313), infrastructure like `Clock` (and in its module: one contract
 * of the instance's identity, no root module of its own): every new thread id (`app.execute`
 * without a `threadId`) and every execution id — roots, children, recursion levels — comes from the
 * application's one `IdGenerator`. A caller's own `threadId` is used as given, a recovered execution
 * keeps its id. The built-in `RandomIdGenerator` unless `@Application({ providers })` lists a class
 * that `extends IdGenerator`; created before the stores that inject it (`deps: [IdGenerator]`), so it
 * may not depend on the contexts. `testWith` runs on `SequentialIdGenerator` (`@agboss/core/testing`:
 * `thread-1`, `execution-1`, …) unless the application lists its own. Never a `pauseId`: that is an
 * answer credential, a random 128-bit token outside it.
 */
export abstract class IdGenerator {
  /** The id of a new thread. */
  abstract newThreadId(): string;

  /** The id of a new execution: a root, a child or a recursion level. */
  abstract newExecutionId(): string;
}

/** The built-in default: a random UUID for each id (the formats before #313, unchanged). */
@Injectable()
export class RandomIdGenerator extends IdGenerator {
  /** A random UUID. */
  newThreadId(): string {
    return randomUUID();
  }

  /** A random UUID. */
  newExecutionId(): string {
    return randomUUID();
  }
}

/** The ids of framework code that runs outside an application (a graph run on its own). */
export const randomIdGenerator: IdGenerator = new RandomIdGenerator();

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
