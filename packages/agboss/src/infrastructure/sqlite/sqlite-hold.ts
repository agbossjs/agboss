import type { DatabaseSync } from "node:sqlite";
import { IdempotencyError } from "../../core/error-families/effect-errors.js";
import type { Milliseconds } from "../../units/index.js";
import { EXECUTION_LEASE } from "../../app/lease-fence.js";
import { systemClock } from "../clock.js";
import { assertLockWaitBudget, LOCK_WAIT_DEADLINE, whileBusy } from "./sqlite-lock-wait.js";
import type { Hold, SqliteMutex } from "./sqlite-mutex.js";
import { afterFailedCommit } from "./sqlite-outcome.js";
import { SqliteTransactionScope, type SqliteTransactionHandle } from "./sqlite-transaction.js";

export { SQLITE_HOLD_CAP } from "./sqlite-lock-wait.js";

/** What a hold runs on: the connection's database, its file's mutex and the connection itself. */
export interface HoldSite {
  readonly database: DatabaseSync;
  readonly mutex: SqliteMutex<SqliteTransactionScope>;
  readonly owner: object;
}

/** The work must not have ended the transaction (COMMIT, END, ROLLBACK … by any route). */
function assertStillOpen(database: DatabaseSync): void {
  if (!database.isTransaction)
    throw new IdempotencyError.TransactionPoisoned({
      message:
        "the runOnce transaction was ended from inside `execute` (a COMMIT, END or ROLLBACK): the effect is rolled back and fails, never half-committed",
    });
}

/** A promise that rejects with `HoldTooLong` once `cap` passes, and never settles when `signal` aborts first. */
function capTimer(cap: Milliseconds, signal: AbortSignal): Promise<never> {
  return systemClock.sleep(cap, signal).then(() => {
    if (signal.aborted) return new Promise<never>(() => undefined);
    throw new IdempotencyError.HoldTooLong({
      message: `a runOnce held the SQLite transaction past its cap of ${String(cap)} ms: rolled back, the queue behind it goes on`,
    });
  });
}

/** What `work` of a hold is given besides the handle: the store's own statements run through it. */
type Trusted = <TInner>(inner: () => TInner) => TInner;

/** The hold's `COMMIT`, a failure of it read as `afterFailedCommit` does. */
function committed(database: DatabaseSync, trusted: Trusted): void {
  try {
    trusted(() => {
      database.exec("COMMIT");
    });
  } catch (error) {
    throw afterFailedCommit(database, error);
  }
}

/** The span itself, once the hold is the file's: `BEGIN IMMEDIATE`, `work` under the cap, then `COMMIT` or `ROLLBACK`. */
async function span<TValue>(
  site: HoldSite,
  hold: Hold<SqliteTransactionScope>,
  work: (handle: SqliteTransactionHandle) => TValue | Promise<TValue>,
  cap: Milliseconds,
): Promise<TValue> {
  const { database, mutex } = site;
  const trusted: Trusted = (inner) => mutex.trusted(inner);
  // another process's hold of the file is waited for without blocking the loop (sqlite-lock-wait.ts)
  await whileBusy(database, () => {
    trusted(() => {
      database.exec("BEGIN IMMEDIATE");
    });
  });
  const scope = new SqliteTransactionScope(database, trusted);
  hold.scope = scope;
  const stop = new AbortController();
  const timer = capTimer(cap, stop.signal);
  timer.catch(() => undefined);
  let result: TValue;
  try {
    const running = Promise.resolve(work(scope.handle));
    // a late rejection after the cap is the attempt's own: nobody listens to it any more
    running.catch(() => undefined);
    result = await Promise.race([running, timer]);
    const { poison } = scope;
    if (poison !== undefined) throw poison;
    assertStillOpen(database);
  } catch (error) {
    scope.close();
    stop.abort();
    if (database.isTransaction)
      trusted(() => {
        database.exec("ROLLBACK");
      });
    throw error;
  }
  stop.abort();
  scope.close();
  committed(database, trusted);
  hold.isCommitted = true;
  return result;
}

/**
 * `work` in the file's one `BEGIN IMMEDIATE … COMMIT` span (#1317c), asynchronous: other operations
 * wait in the queue, never interleaving inside it; lease renewals are served ahead (and re-applied
 * if the span rolls back). The hold is capped (`cap`): past it the transaction is rolled back and
 * the call rejects with `IdempotencyError.HoldTooLong`. A statement that failed through the handle
 * poisons it: the span rolls back, never commits.
 */
export function heldTransaction<TValue>(
  site: HoldSite,
  work: (handle: SqliteTransactionHandle) => TValue | Promise<TValue>,
  cap: Milliseconds,
): Promise<TValue> {
  // a hold longer than the wait other processes are given, or a wait longer than the lease, breaks renewals
  assertLockWaitBudget({ lease: EXECUTION_LEASE, holdCap: cap, deadline: LOCK_WAIT_DEADLINE });
  return site.mutex.hold(
    site.owner,
    (hold) => span(site, hold, work, cap),
    () =>
      new IdempotencyError.NestedRunOnce({
        message: "a runOnce was started inside another's transaction: one transaction at a time",
      }),
  );
}
