import type { DatabaseSync } from "node:sqlite";
import { ConfigError } from "../../core/error-families/config-errors.js";
import { StoreError, StoreErrorKind } from "../../core/error-families/store-errors.js";
import { ms, seconds, type Milliseconds } from "../../units/index.js";
import { keepingAlive, systemClock, waitOf } from "../clock.js";
import { sqliteCodeOf } from "./sqlite-outcome.js";

/**
 * Waiting for another process's SQLite lock (#1317c, money review finding 4). Several instances
 * (processes) share one file, and a `runOnce` of one keeps `BEGIN IMMEDIATE` open across its
 * `execute`, up to `SQLITE_HOLD_CAP`. SQLite's own busy wait is synchronous — it would block the
 * waiting instance's event loop — so the connection runs with `busy_timeout = 0` and a busy answer
 * is tried again here, asynchronously, with a jittered growing pause, up to `LOCK_WAIT_DEADLINE`;
 * past it the call fails with `StoreError.LockTimeout` (nothing was applied, a retry is safe).
 */

/**
 * The longest a `runOnce` keeps the file's transaction open on SQLite (#1317c, decision 10): past it
 * the attempt is rolled back and the file is free for the queue behind it.
 */
export const SQLITE_HOLD_CAP: Milliseconds = seconds(15);

/** The room above the hold cap that a waiter is given: the time of the holder's commit and the next try. */
export const LOCK_WAIT_MARGIN: Milliseconds = seconds(5);

/** How long an operation waits for another process's lock before it fails: a full hold, and the margin. */
export const LOCK_WAIT_DEADLINE: Milliseconds = waitOf(SQLITE_HOLD_CAP + LOCK_WAIT_MARGIN);

/** The longest pause between two tries (milliseconds); the pauses start at 1 and double. */
const LONGEST_PAUSE = 25;

/** SQLite's `SQLITE_BUSY` primary result code. */
const SQLITE_BUSY = 5;

/**
 * The rule the wait lives by: a hold is shorter than the wait (`holdCap < deadline`) and the wait is
 * shorter than the lease (`deadline < lease`), so a renewal that waits through a whole hold still
 * lands before the lease lapses. `ConfigError.Option` otherwise, at start.
 */
export function assertLockWaitBudget(budget: {
  readonly lease: Milliseconds;
  readonly holdCap: Milliseconds;
  readonly deadline?: Milliseconds;
}): void {
  const { lease, holdCap, deadline = LOCK_WAIT_DEADLINE } = budget;
  if (holdCap < deadline && deadline < lease) return;
  throw new ConfigError.Option({
    message: `the SQLite lock wait does not fit the lease: a hold of ${String(holdCap)} ms must be shorter than the wait for the lock (${String(deadline)} ms), which must be shorter than the lease (${String(lease)} ms) — otherwise a renewal that waits through a hold lets the lease lapse`,
  });
}

/** Whether `error` is SQLite saying the file is locked by another connection. */
export const isBusy = (error: unknown): boolean => sqliteCodeOf(error) === SQLITE_BUSY;

/** The pause before the next try: a random part of the window, so waiters do not move in step. */
const jittered = (window: number): number => 1 + Math.floor(Math.random() * window);

/** The wait is over: nothing was applied. */
const lockTimeout = (deadline: Milliseconds, cause: unknown): StoreError.LockTimeout =>
  StoreError.of(StoreErrorKind.LockTimeout, {
    message: `the SQLite file stayed locked by another process for ${String(deadline)} ms: nothing was applied, the call can be tried again`,
    cause,
  });

/** A startup's synchronous wait for the lock is over (`SqliteConnection.startupWork`): nothing was applied. */
export const startupLockTimeout = (window: number, cause: unknown): StoreError.LockTimeout =>
  lockTimeout(ms(window), cause);

/** The tries after the first busy answer, until one passes or the deadline does. */
async function retried(
  attempt: () => unknown,
  isRetryable: (error: unknown) => boolean,
  first: unknown,
  startedAt: number,
  deadline: Milliseconds,
): Promise<unknown> {
  let last = first;
  for (let window = 1; ; window = Math.min(window * 2, LONGEST_PAUSE)) {
    const left = deadline - (systemClock.monotonicNow() - startedAt);
    if (left <= 0) throw lockTimeout(deadline, last);
    await systemClock.sleep(waitOf(Math.min(jittered(window), left)));
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      last = error;
    }
  }
}

/**
 * `attempt` of `database`, tried again — asynchronously, never blocking the event loop — while
 * SQLite answers busy, for at most `deadline`. At once and synchronously when it passes the first
 * time (no extra tick). A busy answer inside an open transaction of this connection is not a lock
 * wait and passes through. The attempt must take its write lock first (`BEGIN IMMEDIATE`, or its one
 * write statement), so a busy answer means nothing ran.
 */
export function whileBusy<TValue>(
  database: DatabaseSync,
  attempt: () => TValue,
  deadline: Milliseconds = LOCK_WAIT_DEADLINE,
): TValue | Promise<Awaited<TValue>> {
  const startedAt = systemClock.monotonicNow();
  const isRetryable = (error: unknown): boolean => isBusy(error) && !database.isTransaction;
  const later = (error: unknown): Promise<Awaited<TValue>> =>
    // a call being waited for is never abandoned: the wait keeps the process alive (#1093)
    keepingAlive(() => retried(attempt, isRetryable, error, startedAt, deadline)) as Promise<
      Awaited<TValue>
    >;
  let result: TValue;
  try {
    result = attempt();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    return later(error);
  }
  if (!(result instanceof Promise)) return result;
  return result.then(undefined, (error: unknown) => {
    if (!isRetryable(error)) throw error;
    return later(error);
  });
}
