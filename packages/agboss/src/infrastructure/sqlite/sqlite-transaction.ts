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

/** The trusted runner of each live handle: only the store's own code (this package) looks it up. */
const trustedRunners = new WeakMap<
  SqliteTransactionHandle,
  <TInner>(inner: () => TInner) => TInner
>();

/** Runs the store's own statements on the open hold (not the user's `execute`, which only has the handle). */
export function trustedOf(
  handle: SqliteTransactionHandle,
): <TInner>(inner: () => TInner) => TInner {
  const trusted = trustedRunners.get(handle);
  if (trusted === undefined) throw new Error("unreachable: a handle that no hold made");
  return trusted;
}

/** The scope of one hold: its handle, and whether it is closed or poisoned. */
export class SqliteTransactionScope {
  #isClosed = false;
  #poison: { readonly cause: unknown } | undefined;
  readonly handle: SqliteTransactionHandle;

  constructor(database: DatabaseSync, trusted: <TInner>(inner: () => TInner) => TInner) {
    const guarded = <TValue>(work: () => TValue, sql?: string): TValue => {
      this.#assertUsable();
      try {
        if (sql !== undefined && controlsTransaction(sql))
          throw new IdempotencyError.NestedTransaction({
            message:
              "a transaction-control statement (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) was run inside an Idempotency.runOnce: the effect's transaction is the store's — an uncaught error rolls everything back, nothing commits it early",
          });
        const done = trusted(work);
        // whatever the statement was, the transaction must still be open
        if (!database.isTransaction)
          throw new IdempotencyError.TransactionPoisoned({
            message: "a statement ended the runOnce transaction: the effect is rolled back",
          });
        return done;
      } catch (error) {
        this.#poison ??= { cause: error };
        throw error;
      }
    };
    this.handle = this.#handleOf(database, guarded);
    trustedRunners.set(this.handle, trusted);
  }

  #handleOf(
    database: DatabaseSync,
    guarded: <TValue>(work: () => TValue, sql?: string) => TValue,
  ): SqliteTransactionHandle {
    return Object.freeze({
      prepare: (sql: string): SqliteTransactionStatement => {
        const statement = guarded(() => database.prepare(sql), sql);
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
        }, sql);
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

/** The keywords that begin, end or nest a transaction. */
const CONTROL = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);

/**
 * One token of SQL: a comment or quoted text (`skipped`), a statement end (`end`), a word, or
 * anything else (blank space, an operator, a digit).
 */
const SQL_TOKEN =
  /(?<skipped>--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`(?:[^`]|``)*`?|\[[^\]]*\]?)|(?<end>;)|(?<word>[A-Za-z_][A-Za-z0-9_$]*)|[\s\S]/gy;

/**
 * Whether any statement of `sql` (a multi-statement string too) is transaction control. Read
 * token by token, skipping comments and quoted text, so `'; commit'` inside a string is not one.
 */
export function controlsTransaction(sql: string): boolean {
  let isStatementStart = true;
  for (const match of sql.matchAll(SQL_TOKEN)) {
    const [text] = match;
    const { word, end } = match.groups ?? {};
    if (end !== undefined) isStatementStart = true;
    else if (word !== undefined && isStatementStart && CONTROL.has(word.toUpperCase())) return true;
    else if (!isBlank(text)) isStatementStart = false;
  }
  return false;
}

/** Space and comments: they neither start nor end a statement. */
const isBlank = (token: string): boolean =>
  /^\s*$/.test(token) || token.startsWith("--") || token.startsWith("/*");
