import type { DatabaseSync } from "node:sqlite";
import { IdempotencyError } from "../../core/error-families/effect-errors.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { systemClock } from "../clock.js";
import type { SqliteMutex } from "./sqlite-mutex.js";
import { afterFailedCommit } from "./sqlite-outcome.js";
import { SqliteTransactionScope, type SqliteTransactionHandle } from "./sqlite-transaction.js";

/**
 * The longest a `runOnce` keeps the file's transaction open on SQLite (#1317c, decision 10): past it
 * the attempt is rolled back and the file is free for the queue behind it — the lease is 30 s, a
 * hold of 15 s leaves its renewals (served ahead of the queue) and every other operation room.
 */
export const SQLITE_HOLD_CAP: Milliseconds = seconds(15);

/** What a hold runs on: the connection's database, its file's mutex and the connection itself. */
export interface HoldSite {
  readonly database: DatabaseSync;
  readonly mutex: SqliteMutex<SqliteTransactionScope>;
  readonly owner: object;
}

/**
 * `work` in the file's one `BEGIN IMMEDIATE … COMMIT` span (#1317c), asynchronous: other operations
 * wait in the queue, never interleaving inside it; lease renewals are served ahead. The hold is
 * capped (`cap`): past it the transaction is rolled back and the call rejects with
 * `IdempotencyError.HoldTooLong`. A statement that failed through the handle poisons it: the span
 * rolls back, never commits.
 */
export function heldTransaction<TValue>(
  site: HoldSite,
  work: (handle: SqliteTransactionHandle) => TValue | Promise<TValue>,
  cap: Milliseconds,
): Promise<TValue> {
  const { database, mutex, owner } = site;
  return mutex.hold(
    owner,
    async (hold) => {
      database.exec("BEGIN IMMEDIATE");
      const scope = new SqliteTransactionScope(database);
      hold.scope = scope;
      const stop = new AbortController();
      const timer = systemClock.sleep(cap, stop.signal).then(() => {
        if (stop.signal.aborted) return new Promise<never>(() => undefined);
        throw new IdempotencyError.HoldTooLong({
          message: `a runOnce held the SQLite transaction past its cap of ${String(cap)} ms: rolled back, the queue behind it goes on`,
        });
      });
      timer.catch(() => undefined);
      let result: TValue;
      try {
        const running = Promise.resolve(work(scope.handle));
        // a late rejection after the cap is the attempt's own: nobody listens to it any more
        running.catch(() => undefined);
        result = await Promise.race([running, timer]);
        const { poison } = scope;
        if (poison !== undefined) throw poison;
      } catch (error) {
        scope.close();
        stop.abort();
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      stop.abort();
      scope.close();
      try {
        database.exec("COMMIT");
      } catch (error) {
        throw afterFailedCommit(database, error);
      }
      return result;
    },
    () =>
      new IdempotencyError.NestedRunOnce({
        message: "a runOnce was started inside another's transaction: one transaction at a time",
      }),
  );
}
