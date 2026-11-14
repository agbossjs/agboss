import type { DatabaseSync } from "node:sqlite";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../store-call-timeout.js";
import { isWriteSql } from "./sqlite-write-sql.js";

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
 * - one single write outside a transaction (its commit is implicit, the same WAL commit phase as
 *   COMMIT, and it counts whichever method runs it: `run`, or `get`/`all` of a `RETURNING`): by
 *   WHITELIST (the rule of #1017), **known** only for the codes that guarantee nothing was applied
 *   before the commit phase (`KNOWN_WRITE_CODES`), every other code is **unknown**;
 * - a read never is.
 * The source is `Transport`: the file system is the channel to the database.
 */

/** The primary result codes this classification reads (the extended ones keep them in the low byte). */
const SQLITE_BUSY = 5;
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

/**
 * The codes of a write outside a transaction that guarantee nothing was applied (the whitelist;
 * https://sqlite.org/rescode.html): each is raised before the statement wrote a page, or makes
 * SQLite roll the statement back whole, never in or after the commit phase.
 * - `SQLITE_BUSY` (5): the write lock was not obtained (after the busy timeout), nothing began; at
 *   an implicit commit a BUSY rolls the statement back (sqlite.org/lang_transaction.html);
 * - `SQLITE_LOCKED` (6): a table lock of this connection, refused before the step;
 * - `SQLITE_READONLY` (8): a write on a read-only database, refused when the write begins;
 * - `SQLITE_TOOBIG` (18): a string or blob over the limit, refused while the row is built;
 * - `SQLITE_CONSTRAINT` (19): a constraint refused the row, the statement is rolled back whole;
 * - `SQLITE_MISMATCH` (20): a datatype mismatch (rowid), raised by the statement's own check;
 * - `SQLITE_MISUSE` (21), `SQLITE_AUTH` (23), `SQLITE_RANGE` (25): the call itself was refused (bad
 *   use, authorizer, a missing bound parameter), before any write.
 * Everything else (`SQLITE_IOERR*`, `FULL`, `NOMEM`, `INTERRUPT`, `PROTOCOL`, `ERROR`, `ABORT`,
 * `CORRUPT`, `CANTOPEN`, an error that is not SQLite's) may come from the commit phase, where a
 * commit frame can already be durable (`FULL` and `NOMEM` after the frame is written to the WAL,
 * before the index is extended): unknown.
 */
const KNOWN_WRITE_CODES: ReadonlySet<number | undefined> = new Set([
  5, 6, 8, 18, 19, 20, 21, 23, 25,
]);

/** What a failed single write outside a transaction is: its error for a whitelisted code, else unknown. */
const afterFailedWrite = (error: unknown): unknown =>
  KNOWN_WRITE_CODES.has(sqliteCodeOf(error)) ? error : unknownOf("write", error);

/** `call` of `database` or one of its statements, a failure outside a transaction read as a single write's. */
function asSingleWrite(database: DatabaseSync, call: () => unknown): unknown {
  const isInTransaction = database.isTransaction;
  try {
    return call();
  } catch (error) {
    throw isInTransaction ? error : afterFailedWrite(error);
  }
}

/** The methods that execute a statement: a write is a write through any of them. */
const EXECUTING: ReadonlySet<string | symbol> = new Set(["run", "get", "all", "iterate"]);

/** `statement` of a write, its executions classified as single writes outside a transaction. */
function classifiedStatement(statement: object, database: DatabaseSync): object {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown =>
        EXECUTING.has(property)
          ? asSingleWrite(database, () => Reflect.apply(value, target, args))
          : Reflect.apply(value, target, args);
    },
  });
}

/** A prepared statement of `sql`, classified when it writes; what a call returned that is not one, as it is. */
function statementOrValue(result: unknown, sql: unknown, database: DatabaseSync): unknown {
  return typeof result === "object" && result !== null && typeof sql === "string" && isWriteSql(sql)
    ? classifiedStatement(result, database)
    : result;
}

/**
 * `database` with its writes classified (#1017): a write statement (by its SQL, through `run`,
 * `get`, `all` or `iterate`), or SQL executed, outside a transaction that fails with a code that is
 * not on the whitelist of `KNOWN_WRITE_CODES` is of unknown outcome. Inside a transaction the
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
        return property === "prepare" ? statementOrValue(result, args[0], target) : result;
      };
    },
  });
}
