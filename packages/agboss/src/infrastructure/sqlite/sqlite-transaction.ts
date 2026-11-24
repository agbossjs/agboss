import type { DatabaseSync } from "node:sqlite";
import { IdempotencyError } from "../../core/error-families/effect-errors.js";

/**
 * The transaction of a `runOnce` on SQLite (#1317c), as a repository of the application sees it:
 * `connection.requireTransaction()` inside `execute`. A guarded view of the connection — no
 * `DatabaseSync`, no `close`, no way to begin or end the transaction — that dies when the attempt
 * ends or times out (a late statement fails with `IdempotencyError.OutsideTransaction`, nothing
 * written) and is poisoned by the first statement that throws: every later statement fails with
 * `IdempotencyError.TransactionPoisoned`, and the transaction rolls back instead of committing — so
 * a caught query error can never leave a half-written effect committed.
 */

/** What a statement of the transaction answers to a write. */
export interface SqliteTransactionRun {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** What a statement binds. */
export type SqliteTransactionParameters = readonly (string | number | bigint | Uint8Array | null)[];

/** A prepared statement of the transaction. */
export interface SqliteTransactionStatement {
  run(...parameters: SqliteTransactionParameters): SqliteTransactionRun;
  get(...parameters: SqliteTransactionParameters): unknown;
  all(...parameters: SqliteTransactionParameters): unknown[];
}

/** The guarded transaction handle a repository writes through. */
export interface SqliteTransactionHandle {
  prepare(sql: string): SqliteTransactionStatement;
  exec(sql: string): void;
}

/** The scope of one hold: its handle, and whether it is closed or poisoned. */
export class SqliteTransactionScope {
  #isClosed = false;
  #poison: { readonly cause: unknown } | undefined;
  readonly handle: SqliteTransactionHandle;

  constructor(database: DatabaseSync) {
    const guarded = <TValue>(work: () => TValue): TValue => {
      this.#assertUsable();
      try {
        return work();
      } catch (error) {
        this.#poison ??= { cause: error };
        throw error;
      }
    };
    this.handle = Object.freeze({
      prepare: (sql: string): SqliteTransactionStatement => {
        const statement = guarded(() => database.prepare(sql));
        return Object.freeze({
          run: (...parameters: SqliteTransactionParameters) =>
            guarded(() => statement.run(...parameters)),
          get: (...parameters: SqliteTransactionParameters) =>
            guarded(() => statement.get(...parameters)),
          all: (...parameters: SqliteTransactionParameters) =>
            guarded(() => statement.all(...parameters)),
        });
      },
      exec: (sql: string): void => {
        guarded(() => {
          database.exec(sql);
        });
      },
    });
  }

  #assertUsable(): void {
    if (this.#isClosed)
      throw new IdempotencyError.OutsideTransaction({
        message:
          "the runOnce transaction is over (it ended, timed out or was rolled back): a statement of a late `execute` writes nothing",
      });
    if (this.#poison !== undefined)
      throw new IdempotencyError.TransactionPoisoned({
        message:
          "a statement of this runOnce transaction already failed: it can only roll back — every further statement is refused",
        cause: this.#poison.cause,
      });
  }

  /** The error that poisoned the transaction, when one did: it must roll back, never commit. */
  get poison(): IdempotencyError.TransactionPoisoned | undefined {
    if (this.#poison === undefined) return undefined;
    return new IdempotencyError.TransactionPoisoned({
      message:
        "a statement of the runOnce transaction failed and the error was caught: the transaction is rolled back, never committed half-written",
      cause: this.#poison.cause,
    });
  }

  /** Ends the handle: every later statement is refused. */
  close(): void {
    this.#isClosed = true;
  }
}
