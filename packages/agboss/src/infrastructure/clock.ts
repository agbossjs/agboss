import { randomUUID } from "node:crypto";
import { Injectable } from "../components/decorators.js";
import {
  DuplicateExecutionIdError,
  ThreadIdsExhaustedError,
  InvalidMintedIdError,
  KeyTextRule,
  keyTextRuleOf,
} from "../core/errors.js";
import type { ExecutionIdentity, ExecutionLeaseRepository } from "./execution-lease.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { Brand } from "../types/brand.js";

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
   * of two readings means anything: the elapsed time a lease's holder fences itself with, so an
   * offset or a step of its wall clock does not move its fence. The default is the process's
   * monotonic clock (`performance.now()`), whatever `now()` says; a clock whose time is not real
   * time (a test's virtual clock) overrides it with its own.
   */
  monotonicNow(): number {
    return performance.now();
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
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: an abort event fires once, and `done` removes the listener itself either way
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * Where a store's time comes from (#533, G7): what `StoreClock.source` says, read by every store
 * that decides a lease's expiry.
 */
export enum StoreTimeSource {
  /**
   * Production: a networked store reads its database's own time inside each statement that takes,
   * renews, fences or closes a lease (PostgreSQL's `clock_timestamp()`), so every instance agrees on
   * the instant of expiry whatever its wall clock says; a store on one host (in-memory, SQLite)
   * reads `now()`, the host's clock.
   */
  Database = "database",
  /**
   * Every store reads `now()`, the application's clock, the networked ones too: the instances'
   * clocks must then agree — an offset between hosts moves the instant of expiry.
   */
  Host = "host",
  /** A test's clock: every store reads `now()`, so `clock.advance` crosses an expiry. */
  Test = "test",
}

/**
 * An instant on a store's clock (#533, G7): what `StoreClock.now()` answers — a `Date`, branded so
 * that the application's `Clock` (whose `now()` is a plain `Date`, skewed by `ClockSkew` in a test)
 * does not satisfy `Pick<StoreClock, "now">`: a fencing store that injects `Clock` by mistake does
 * not compile.
 */
export type StoreTime = Brand<Date, "StoreTime">;

/**
 * The time a store decides a lease's expiry by (#533) — a seam, never listed: the application
 * provides it (`StoreTimeSource.Database` on the application's clock), a test its own
 * (`StoreTimeSource.Test`). A store takes it in its `deps` — `@Injectable({ deps:
 * [PostgresConnection, StoreClock, ApplicationContext] })` — and reads the database's time exactly
 * when `source` is `StoreTimeSource.Database`, `now()` otherwise.
 */
export class StoreClock {
  /**
   * @param source where a networked store's time comes from.
   * @param clock the time of a store with no clock of its own, and of every store when `source`
   *   is not `Database`.
   * Both default to what an application provides (the database's time, the system's clock): a
   * container with no application (`agboss check` creating a workflow's components) builds it so.
   */
  constructor(
    readonly source: StoreTimeSource = StoreTimeSource.Database,
    private readonly clock: Pick<Clock, "now"> = systemClock,
  ) {}

  /** The time of a store that has no clock of its own (in-memory, SQLite), and of every store off `Database`. */
  now(): StoreTime {
    return this.clock.now() as StoreTime;
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
 * answer credential, a random 128-bit token outside it. An id is never repeated over the life of
 * the application's stores (#591): every execution id minted is kept by the lease store before use
 * (`claimExecutionId`) and one any execution had — of any tenant, running or over — fails
 * the new execution with `DuplicateExecutionIdError` before it is written; a minted thread id the
 * tenant already has is minted again (#550).
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

/**
 * The application's `IdGenerator` as the framework mints through it (#578): every id a key's text
 * (`keyTextRuleOf`), else `InvalidMintedIdError` before the id is used — a project's own generator
 * minting `x\uD800` and `x\uDFFF` would make two trees one lease on a UTF-8 store.
 */
export class CheckedIdGenerator extends IdGenerator {
  constructor(readonly minting: IdGenerator) {
    super();
  }

  newThreadId(): string {
    return this.#checked("newThreadId", this.minting.newThreadId());
  }

  newExecutionId(): string {
    return this.#checked("newExecutionId", this.minting.newExecutionId());
  }

  #checked(method: "newThreadId" | "newExecutionId", id: unknown): string {
    // a JavaScript project's generator may return anything: no text is no key's length
    const rule = typeof id === "string" ? keyTextRuleOf(id) : KeyTextRule.Length;
    if (rule === undefined) return id as string;
    throw new InvalidMintedIdError({ generator: this.minting.constructor.name, method, rule });
  }
}

/** The ids of framework code that runs outside an application (a graph run on its own). */
export const randomIdGenerator: IdGenerator = new RandomIdGenerator();

/**
 * How the framework makes a new execution's id (#591) — a root, a child, a recursion level: the
 * application's `IdGenerator` mints it (checked, #578) and the lease store keeps it
 * (`claimExecutionId`) before anything else of the execution is written — its budgets'
 * amounts, its thread, its lease, its marker, its checkpoint. An id another execution ever had is
 * `DuplicateExecutionIdError`: two trees never share a lease, a fencing token, a audit log or a step
 * key, whatever the generator does. A resume and a recovery keep their id and never come here.
 */
export interface ExecutionIds {
  /** A new execution's id for `tenantId`, kept; `DuplicateExecutionIdError` when it was taken. */
  newExecutionId(tenantId: string): Promise<string>;
}

/**
 * The class a refusal of its ids names (#591, #613): the project's own generator, never the
 * framework's check around it — for a store of your own that refuses a minted id too.
 */
export const idGeneratorNameOf = (idGenerator: object): string =>
  (idGenerator instanceof CheckedIdGenerator ? idGenerator.minting : idGenerator).constructor.name;

/** The thread ids a record store mints (#550, #613): the generator's, a typed refusal when exhausted. */
export interface MintedThreadIds {
  newThreadId(): string;
  exhausted(tries: number): Error;
}

/** `idGenerator`'s thread ids for a record store: `ThreadIdsExhaustedError` once every try is taken. */
export const mintedThreadIdsOf = (idGenerator: IdGenerator): MintedThreadIds => ({
  newThreadId: () => idGenerator.newThreadId(),
  exhausted: (tries) =>
    new ThreadIdsExhaustedError({ generator: idGeneratorNameOf(idGenerator), tries }),
});

/** The ids of an application instance: minted by `idGenerator`, kept in `leases`. */
export const executionIdsOf = (
  idGenerator: IdGenerator,
  leases: Pick<ExecutionLeaseRepository, "claimExecutionId">,
): ExecutionIds => ({
  async newExecutionId(tenantId: string): Promise<string> {
    const executionId = idGenerator.newExecutionId();
    if (await leases.claimExecutionId({ executionId, tenantId })) return executionId;
    throw new DuplicateExecutionIdError({ generator: idGeneratorNameOf(idGenerator) });
  },
});

/**
 * An execution id reserved before its execution starts (#807: an A2A task's id, known when the task
 * is accepted): minted like any other, kept by the lease store only when the execution starts — or
 * when a sweep fences it, so that none ever can. The claim is the same arbiter as a minted id's, so
 * one reserved id starts at most one execution, ever.
 */
export interface ReservedExecutionIds {
  /** Keeps the id now: `true` when this call kept it, `false` when it was kept before. */
  claim(identity: ExecutionIdentity): Promise<boolean>;
  /** The id, kept now for its execution; `DuplicateExecutionIdError` when it was kept before. */
  keep(identity: ExecutionIdentity): Promise<string>;
}

/** The reserved ids of an application instance, kept in `leases`. */
export const reservedExecutionIdsOf = (
  idGenerator: IdGenerator,
  leases: Pick<ExecutionLeaseRepository, "claimExecutionId">,
): ReservedExecutionIds => ({
  claim: (identity) => leases.claimExecutionId(identity),
  async keep(identity: ExecutionIdentity): Promise<string> {
    if (await leases.claimExecutionId(identity)) return identity.executionId;
    throw new DuplicateExecutionIdError({ generator: idGeneratorNameOf(idGenerator) });
  },
});

/** A graph run with no application (no store to keep ids in): random ids, kept nowhere. */
export const unkeptExecutionIds: ExecutionIds = {
  newExecutionId: () => Promise.resolve(randomIdGenerator.newExecutionId()),
};

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
 * The core's lazy loads in flight (#646): a module loaded on first use (`await
 * lazyLoad(import("./x.js"))`, every dynamic import of the core — lint-enforced), a project file
 * loaded by path. Under vitest a first load goes through vite's module runner, many turns of the
 * event loop, so a test's `clock.advance` waits for them before it moves the time.
 */
const loading = new Set<Promise<void>>();

/** Returns `load` as it is, kept in flight until it settles. */
export function lazyLoad<T>(load: Promise<T>): Promise<T> {
  const settled = load.then(
    () => undefined,
    () => undefined,
  );
  loading.add(settled);
  void settled.then(() => loading.delete(settled));
  return load;
}

/** The lazy loads in flight now, each as a promise that never rejects. */
export const loadsInFlight = (): readonly Promise<void>[] => [...loading];

/**
 * A computed wait (a retry delay, a `Retry-After`) as a duration: the brand is applied here, once,
 * to a finite number of milliseconds ≥ 0.
 */
export const waitOf = (amount: number): Milliseconds => Math.max(0, amount) as Milliseconds;

/**
 * `value`, which an invariant of the caller says is defined there (#619): the check is no branch
 * of the caller's own, so a mutation test finds no equivalent mutant in it — a `?:` or an `if`
 * whose other side never runs. Undefined is a bug, never a state to handle: an `Error` naming the
 * invariant broken, as `unreachable: …` elsewhere.
 */
export function definedOf<TValue>(value: TValue | undefined, invariant: string): TValue {
  if (value === undefined) throw new Error(`unreachable: ${invariant}`);
  return value;
}

/**
 * Blocks this thread for `delay` milliseconds (#911): a real-time wait that no `Clock` can
 * drive, for the one place that must pause inside synchronous code — opening the SQLite file at
 * startup, before the event loop serves anything and inside a deadline the caller bounds (the busy
 * timeout). Never call it from anything that runs while the application serves; everywhere else the
 * wait is `Clock.sleep`. `agboss/no-direct-time` flags `Atomics.wait`, so this is its one site.
 */
export function pauseThread(delay: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
