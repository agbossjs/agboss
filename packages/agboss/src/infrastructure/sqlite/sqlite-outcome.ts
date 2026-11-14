import type { DatabaseSync } from "node:sqlite";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../store-call-timeout.js";

/**
 * Which errors of SQLite leave a write's outcome unknown (#1017). SQLite runs in the process and
 * answers synchronously, so a statement either ran or threw and there is no lost answer: the one
 * window is the commit, where the database file is made durable (the journal's sync and delete, or
 * the WAL's commit frame and its sync). An error there may come before the commit point (rolled
 * back) or after it (applied), and the caller cannot tell:
 * - the COMMIT statement failing with anything but `SQLITE_BUSY` or `SQLITE_CONSTRAINT` (a deferred
 *   foreign key) is **unknown** — `SQLITE_IOERR` and its extended codes, `SQLITE_FULL`,
 *   `SQLITE_NOMEM`, `SQLITE_INTERRUPT`, `SQLITE_PROTOCOL`, anything else: when unsure, unknown;
 * - `SQLITE_BUSY` and `SQLITE_CONSTRAINT` at COMMIT: SQLite documents that the transaction stays
 *   open (https://sqlite.org/lang_transaction.html, https://sqlite.org/foreignkeys.html), nothing
 *   was applied, and it is rolled back: **known**;
 * - an error of any statement before the COMMIT: rolled back, **known**, whatever its code;
 * - one single write outside a transaction (its commit is implicit): `SQLITE_IOERR` is **unknown**,
 *   any other code is the statement's own refusal, rolled back as a whole: **known**;
 * - a read never is.
 * The source is `Transport`: the file system is the channel to the database.
 */

/** The primary result codes this classification reads (the extended ones keep them in the low byte). */
const SQLITE_BUSY = 5;
const SQLITE_IOERR = 10;
const SQLITE_CONSTRAINT = 19;
const PRIMARY_CODE_MASK = 0xff;

/** SQLite's primary result code of `error`; `undefined` for an error that is not SQLite's. */
export function sqliteCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number")
    return undefined;
  return error.errcode & PRIMARY_CODE_MASK;
}

/** The error of unknown outcome that `cause`, an error of `operation`, is read as. */
const unknownOf = (operation: string, cause: unknown): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({
    ...{ store: "SqliteConnection", operation, source: StoreOutcomeSource.Transport },
    cause,
  });

/**
 * What a failed `COMMIT` is: its error when SQLite says the transaction stays open (nothing was
 * applied), else an error of unknown outcome. The transaction is rolled back as far as it can be.
 */
export function afterFailedCommit(database: DatabaseSync, error: unknown): unknown {
  const code = sqliteCodeOf(error);
  const isOpen = code === SQLITE_BUSY || code === SQLITE_CONSTRAINT;
  try {
    if (database.isTransaction) database.exec("ROLLBACK");
  } catch (rollback) {
    // the connection is past use: the commit's own error is what the caller must hear
    if (isOpen) return error;
    return unknownOf("COMMIT", new AggregateError([error, rollback], "COMMIT and ROLLBACK failed"));
  }
  return isOpen ? error : unknownOf("COMMIT", error);
}

/** What a failed single write outside a transaction is: unknown for an I/O error, else its error. */
const afterFailedWrite = (error: unknown): unknown =>
  sqliteCodeOf(error) === SQLITE_IOERR ? unknownOf("write", error) : error;

/** `call` of `database` or one of its statements, a failure outside a transaction read as a single write's. */
function asSingleWrite(database: DatabaseSync, call: () => unknown): unknown {
  const isInTransaction = database.isTransaction;
  try {
    return call();
  } catch (error) {
    throw isInTransaction ? error : afterFailedWrite(error);
  }
}

/** `statement`, its writes (`run`) classified as single writes outside a transaction. */
function classifiedStatement(statement: object, database: DatabaseSync): object {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown =>
        property === "run"
          ? asSingleWrite(database, () => Reflect.apply(value, target, args))
          : Reflect.apply(value, target, args);
    },
  });
}

/** A statement of the database, or what a call returned that is not one. */
function statementOrValue(result: unknown, database: DatabaseSync): unknown {
  return typeof result === "object" && result !== null
    ? classifiedStatement(result, database)
    : result;
}

/**
 * `database` with its writes classified (#1017): a statement run, or SQL executed, outside a
 * transaction that fails with an I/O error is of unknown outcome. Inside a transaction the
 * statements are the transaction's, and `inImmediateTransaction` classifies its COMMIT. Every
 * other member is the database's own.
 */
export function classifiedDatabase(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (property === "exec")
          return asSingleWrite(target, () => Reflect.apply(value, target, args));
        const result: unknown = Reflect.apply(value, target, args);
        return property === "prepare" ? statementOrValue(result, target) : result;
      };
    },
  });
}
