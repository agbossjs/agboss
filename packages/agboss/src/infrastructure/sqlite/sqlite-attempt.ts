import type { DatabaseSync } from "node:sqlite";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../store-call-timeout.js";
import { afterFailedCommit, sqliteCodeOf } from "./sqlite-outcome.js";
import { isWriteSql } from "./sqlite-write-sql.js";

/** SQLite's `SQLITE_BUSY` primary result code. */
const SQLITE_BUSY = 5;

/** Transaction control: never a write of its own, and never starts the attempt's transaction. */
const CONTROL = /^\s*(?:begin|commit|end|rollback|savepoint|release)\b/i;

/**
 * One gated operation as ONE clean attempt (#1317c, money review): what a retry after
 * `SQLITE_BUSY` may rely on is that nothing of the failed try is left behind.
 * - The attempt's first write statement takes the file's write lock with `BEGIN IMMEDIATE` and the
 *   attempt ends with `COMMIT`, so an operation of several autocommit statements is one
 *   transaction, and a `BUSY` can only be the lock itself, answered before any write.
 *   An operation that opens its own transaction (`connection.transaction`) is the same transaction
 *   (`connection.transaction` joins it as a savepoint); reads before the first write take no lock.
 * - The guard under it: `total_changes()` before the try and after a busy answer. A busy answer
 *   after rows changed (a write path that skipped the attempt) is never retried — the call would
 *   repeat that write — it fails with `StoreOutcomeUnknownError`.
 * The attempt is the synchronous part of the operation: the repositories' statements run with no
 * `await` between them (the file's mutex relies on the same), so the transaction ends when the
 * operation returns.
 */
export class CleanAttempt {
  readonly #database: DatabaseSync;
  #isOpen = false;
  #isOwner = false;
  #changes: ReturnType<DatabaseSync["prepare"]> | undefined;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Whether an attempt is running (its statements are the attempt's, a nested operation joins it). */
  get isRunning(): boolean {
    return this.#isOpen;
  }

  /**
   * The attempt's transaction, begun now if it is not yet (`connection.transaction` inside an
   * operation): `true` when the operation's statements are now one transaction, `false` outside an attempt.
   */
  lock(): boolean {
    if (!this.#isOpen) return false;
    if (!this.#isOwner && !this.#database.isTransaction) {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#isOwner = true;
    }
    return this.#isOwner;
  }

  /** Called before every statement of the connection: the first write of an attempt takes the lock. */
  beforeStatement(sql: string): void {
    if (!this.#isOpen || this.#isOwner || this.#database.isTransaction) return;
    if (CONTROL.test(sql) || !isWriteSql(sql)) return;
    // busy here: nothing was written; the whole attempt is tried again from the start
    this.#database.exec("BEGIN IMMEDIATE");
    this.#isOwner = true;
  }

  /** `work` as one attempt; a nested call, or a call inside an open transaction, is part of the open one. */
  run<TValue>(work: () => TValue): TValue {
    // a closed file answers from the statement itself; inside a transaction the attempt is its owner's
    if (this.#isOpen || !this.#database.isOpen || this.#database.isTransaction) return work();
    const before = this.#totalChanges();
    this.#isOpen = true;
    this.#isOwner = false;
    let result: TValue;
    try {
      result = work();
    } catch (error) {
      // rows of the attempt's own transaction are rolled back: only a write outside it counts
      throw this.#abandoned() ? error : this.#guarded(error, before);
    } finally {
      this.#isOpen = false;
    }
    this.#committed();
    if (!(result instanceof Promise)) return result;
    return result.then(undefined, (error: unknown) => {
      throw this.#guarded(error, before);
    }) as TValue;
  }

  #totalChanges(): number {
    this.#changes ??= this.#database.prepare("SELECT total_changes() AS n");
    return Number((this.#changes.get() as { n: number | bigint }).n);
  }

  /** The attempt's own transaction ends, the work having failed: whether there was one (nothing it wrote stays). */
  #abandoned(): boolean {
    const wasOwner = this.#isOwner;
    if (wasOwner && this.#database.isTransaction) this.#database.exec("ROLLBACK");
    this.#isOwner = false;
    return wasOwner;
  }

  #committed(): void {
    if (!this.#isOwner) return;
    this.#isOwner = false;
    try {
      this.#database.exec("COMMIT");
    } catch (error) {
      throw afterFailedCommit(this.#database, error);
    }
  }

  /** A busy answer after rows changed outside the attempt's transaction: never retried. */
  #guarded(error: unknown, before: number): unknown {
    if (sqliteCodeOf(error) !== SQLITE_BUSY || this.#totalChanges() === before) return error;
    return new StoreOutcomeUnknownError({
      store: "SqliteConnection",
      operation: "write",
      source: StoreOutcomeSource.Transport,
      cause: error,
    });
  }
}

/** `work` inside the open transaction, as a savepoint: its own failure undoes only its own statements. */
export function joinedTransaction<TResult>(database: DatabaseSync, work: () => TResult): TResult {
  database.exec("SAVEPOINT agboss_nested");
  try {
    const result = work();
    database.exec("RELEASE agboss_nested");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK TO agboss_nested; RELEASE agboss_nested");
    throw error;
  }
}

/**
 * `work` in one `BEGIN IMMEDIATE` transaction: the write lock is taken first, so of two connections
 * one waits (up to the busy timeout) and each sees the other's committed rows. Rolled back when
 * `work` throws. `work` is synchronous — nothing else runs on this connection meanwhile. A COMMIT
 * that fails is `StoreOutcomeUnknownError` unless SQLite leaves the transaction open (#1017).
 */
export function inImmediateTransaction<TResult>(
  database: DatabaseSync,
  work: () => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  let result: TResult;
  try {
    result = work();
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  try {
    database.exec("COMMIT");
  } catch (error) {
    // #1017: a failed COMMIT may have been applied (sqlite-outcome.ts)
    throw afterFailedCommit(database, error);
  }
  return result;
}
