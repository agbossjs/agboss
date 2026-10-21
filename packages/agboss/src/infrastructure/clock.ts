import { randomUUID } from "node:crypto";
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

/**
 * The ids the framework mints (#313), infrastructure like `Clock` (and in its module: one contract
 * of the instance's identity, no root module of its own): every new thread id (`app.execute`
 * without a `threadId`) and every execution id — roots, children, recursion levels — comes from the
 * application's one `IdGenerator`. A caller's own `threadId` is used as given, a recovered execution
 * keeps its id. The built-in `RandomIdGenerator` unless `@Application({ providers })` lists a class
 * that `extends IdGenerator`; created before the stores that inject it (`deps: [IdGenerator]`), so it
 * may not depend on the contexts. `testWith` runs on `SequentialIdGenerator` (`agboss/testing`:
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
