import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ConfigError } from "../../core/error-families/config-errors.js";
import { Injectable } from "../../components/decorators.js";
import { DATABASE_SETTINGS, type ResolvedSettings } from "../../storage/settings.js";
import { sqliteSettingsOf } from "./sqlite-settings.js";
import type { Class } from "../../components/injection.js";
import type { OnDestroy } from "../../components/container/lifecycle.js";
import { classifiedDatabase } from "./sqlite-outcome.js";
import { ensureBaselineSchema } from "./sqlite-baseline-schema.js";
import { checkedSchemaVersion } from "./sqlite-schema-version.js";
import { BUSY_TIMEOUT, openSqliteDatabase } from "./sqlite-open.js";
export { BUSY_TIMEOUT, openSqliteDatabase } from "./sqlite-open.js";
import { CleanAttempt, inImmediateTransaction, joinedTransaction } from "./sqlite-attempt.js";
export { inImmediateTransaction } from "./sqlite-attempt.js";
import { guardedDatabase } from "./sqlite-guard.js";
import { heldTransaction, SQLITE_HOLD_CAP } from "./sqlite-hold.js";
import { assertLockWaitBudget, isBusy, startupLockTimeout, whileBusy } from "./sqlite-lock-wait.js";
import { EXECUTION_LEASE } from "../../app/lease-fence.js";
export { SQLITE_HOLD_CAP } from "./sqlite-hold.js";
import { gatedSqliteImplementation, type SqliteGateOptions } from "./sqlite-gate.js";
import { ambientHoldScope, mutexOfSqliteFile, type SqliteMutex } from "./sqlite-mutex.js";
import { SqliteTransactionScope, type SqliteTransactionHandle } from "./sqlite-transaction.js";
import { ServedGroups } from "./sqlite-served.js";
import { IdempotencyError } from "../../core/error-families/effect-errors.js";
import { runOnceNameOf } from "../../app/idempotency-scope.js";
import type { Milliseconds } from "../../units/index.js";

export { SQLITE_SCHEMA_VERSION } from "./sqlite-schema-version.js";

/**
 * The SQLite file of an application instance (#265 S32): one `DatabaseSync` (`node:sqlite`, loaded
 * on first use) on the `path` of the storage's `SqliteDriver`, shared by every SQLite implementation the
 * application lists — two instances open two connections to one file. `journal_mode=WAL` (readers never
 * block the writer; its switch on a new file, tried again while busy, the whole open bounded by the
 * busy timeout, #911), and every atomic operation in one `BEGIN IMMEDIATE` transaction. The driver is
 * synchronous: a transaction is one group of statements with no `await` inside. SQLite's own busy
 * wait would block this instance's event loop, so once the file is open `busy_timeout` is 0 and an
 * operation that meets another process's lock waits asynchronously (`whileBusy`, up to
 * `LOCK_WAIT_DEADLINE`, then `StoreError.LockTimeout`).
 * Time values are parameters from the framework's clock, never SQLite's own.
 */

/** What a SQLite implementation reads from its driver's settings: the `path` (`:memory:` in tests). */
const SqliteSettings = z.object({
  sqlitePath: z.string().min(1, "path is empty — a file path, or :memory: in tests"),
});

/** One row of `PRAGMA table_info`: a column's name. */
const ColumnRow = z.looseObject({ name: z.string() });

/**
 * The SQLite connection of one application instance: created only by the container, shared by its
 * SQLite stores — and the DI token a subclass of a SQLite implementation names in its `deps`
 * (`@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })`, #265 S70; a fencing
 * store's — the lease, fenced-effect and outbound-call stores — `[SqliteConnection, StoreClock,
 * ApplicationContext]`, #847: a `Clock` does not pass for its `StoreClock`). Its file is the
 * `path` of the application's `@DatabaseStorage({ driver: SqliteDriver({ path }) })`, and nothing else.
 */
@Injectable({ deps: [DATABASE_SETTINGS] })
export class SqliteConnection implements OnDestroy {
  /** The file (`SqliteDriver`'s `path`); `:memory:` keeps the database in this connection only. */
  readonly path: string;
  readonly #prepared = new Set<string>();
  readonly #database: DatabaseSync;
  readonly #mutex: SqliteMutex<SqliteTransactionScope>;
  readonly #attempt: CleanAttempt;
  readonly #served = new ServedGroups(this);

  constructor(settings?: ResolvedSettings) {
    if (settings === undefined)
      throw new ConfigError.Option({
        message:
          "the SQLite implementations need the application's @DatabaseStorage({ driver: SqliteDriver({ path }) }) — the file they open (`:memory:` in a unit test)",
      });
    const parsed = SqliteSettings.safeParse(sqliteSettingsOf(settings));
    if (!parsed.success) {
      // Stryker disable next-line StringLiteral: equivalent: the settings have the one field, so there is one issue and nothing to join
      const problems = parsed.error.issues.map((issue) => issue.message).join("; ");
      throw new ConfigError.Option({
        message: `the SQLite implementations need SqliteDriver's path: string — ${problems}`,
      });
    }
    // the wait for another process's lock fits the lease, or the instance does not start
    assertLockWaitBudget({ lease: EXECUTION_LEASE, holdCap: SQLITE_HOLD_CAP });
    this.path = parsed.data.sqlitePath;
    const database = openSqliteDatabase(this.path);
    checkedSchemaVersion(database);
    try {
      ensureBaselineSchema(database);
      // the open above may wait for the file (synchronous startup); from here on no wait blocks the loop
      database.exec("PRAGMA busy_timeout = 0");
    } catch (error) {
      database.close();
      throw error;
    }
    this.#mutex = mutexOfSqliteFile(this.path) as SqliteMutex<SqliteTransactionScope>;
    const classified = classifiedDatabase(database);
    this.#attempt = new CleanAttempt(classified);
    this.#database = guardedDatabase(classified, {
      mutex: this.#mutex,
      owner: this,
      attempt: this.#attempt,
      served: this.#served,
    });
  }

  /** The database itself: for the statements of one store. */
  get database(): DatabaseSync {
    return this.#database;
  }

  /**
   * One `SELECT 1` on the file (#300): every SQLite store's `ping()`. Rejects when the connection
   * is closed or the file cannot be read.
   */
  ping(): Promise<void> {
    // one read, served even inside an open `runOnce` transaction: a health check never waits for it
    return new Promise<void>((resolve) => {
      void this.#mutex.ahead(this, () =>
        this.#served.served(() => this.#database.prepare("SELECT 1").get()),
      );
      resolve();
    });
  }

  /**
   * `work` (synchronous statements) once no `runOnce` transaction is open on the file (#1317c): at
   * once when none is, else queued behind it, in order. Every operation of every SQLite repository
   * goes through here — never inside another's open transaction. Priority: a single statement of a
   * lease renewal is served ahead of the queue, inside the open transaction of this connection.
   * The gate covers a repository method only up to its first `await`: each group of statements
   * after one is served again here, at the point it runs (else it fails, `sqlite-served.ts`).
   */
  serve<TValue>(
    work: () => TValue,
    options?: { readonly isPriority?: boolean; readonly isRenewal?: boolean },
  ): Promise<Awaited<TValue>> {
    return Promise.resolve(this.gate(work, options));
  }

  /** `serve` that returns what `work` returns as it is when no transaction is open (no extra tick). */
  gate<TValue>(
    work: () => TValue,
    options?: { readonly isPriority?: boolean; readonly isRenewal?: boolean },
  ): TValue | Promise<Awaited<TValue>> {
    // called from inside another operation: part of its attempt, its busy answer the outer one's
    if (this.#attempt.isRunning) return this.#mutex.whenFree(() => this.#served.served(work));
    // each try asks the mutex again (a hold of this process may have opened meanwhile) and is one
    // clean attempt (sqlite-attempt.ts), a served group: a retry never repeats a write
    return whileBusy(this.#database, () => {
      const attempt = (): TValue => this.#served.served(() => this.#attempt.run(work));
      return options?.isPriority === true
        ? this.#mutex.ahead(this, attempt, options.isRenewal === true)
        : this.#mutex.whenFree(attempt);
    });
  }

  /** Whether the caller is inside this file's open `runOnce` transaction. */
  get isInTransaction(): boolean {
    return this.#mutex.isInside;
  }

  /**
   * The transaction of the `runOnce` the caller is inside of (#1317c), as a guarded handle a
   * repository writes through: its statements roll back with the effect. Outside one, or in a
   * `runOnce` an in-memory store runs, `IdempotencyError.OutsideTransaction`.
   */
  requireTransaction(): SqliteTransactionHandle {
    const hold = this.#mutex.isInside ? this.#mutex.active : undefined;
    const scope = hold?.scope;
    if (scope !== undefined) return scope.handle;
    const name = runOnceNameOf();
    throw new IdempotencyError.OutsideTransaction({
      message:
        name === undefined
          ? "requireTransaction() was called outside an Idempotency.runOnce: a repository takes the effect's transaction only inside `execute`"
          : `requireTransaction() was called inside runOnce "${name}", which runs on a store that has no SQLite transaction (an in-memory fenced-effect store): list SqliteFencedEffectRepository, or test the repository on SQLite`,
    });
  }

  /**
   * `work` in the file's one `BEGIN IMMEDIATE … COMMIT` span (#1317c), asynchronous: other
   * operations wait in the queue, never interleaving inside it; lease renewals are served ahead. The
   * hold is capped (`cap`, default `SQLITE_HOLD_CAP`): past it the transaction is rolled back and
   * the call rejects with `IdempotencyError.HoldTooLong`. A statement that failed through the handle
   * poisons it: the span rolls back, never commits.
   */
  held<TValue>(
    work: (handle: SqliteTransactionHandle) => TValue | Promise<TValue>,
    cap: Milliseconds = SQLITE_HOLD_CAP,
  ): Promise<TValue> {
    return heldTransaction(
      { database: this.#database, mutex: this.#mutex, owner: this },
      work,
      cap,
    );
  }

  /**
   * Runs an application repository's own `CREATE TABLE IF NOT EXISTS …` once per connection (the
   * framework's tables are made at open by `ensureBaselineSchema`; this is for the application's).
   */
  ensureSchema(name: string, ddl: string): void {
    if (this.#prepared.has(name)) return;
    this.startupWork(() => {
      inImmediateTransaction(this.#database, () => {
        this.#database.exec(ddl);
      });
    });
    this.#prepared.add(name);
  }

  /**
   * Synchronous work at startup — a repository's DDL or migration, which cannot await: SQLite may
   * wait for another process's write lock here, as at the open (`BUSY_TIMEOUT`, or `window`), then
   * `busy_timeout` is 0 again. A lock held past the window is `StoreError.LockTimeout`, nothing
   * applied, never a raw "database is locked" (#1317).
   */
  startupWork<T>(work: () => T, window: number = BUSY_TIMEOUT): T {
    this.#database.exec(`PRAGMA busy_timeout = ${String(window)}`);
    try {
      return work();
    } catch (error) {
      throw isBusy(error) ? startupLockTimeout(window, error) : error;
    } finally {
      this.#database.exec("PRAGMA busy_timeout = 0");
    }
  }

  /** The columns a table of this file has now (none when it does not exist): what a shape-keyed schema step reads. */
  columnsOf(table: string): readonly string[] {
    return this.#database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => ColumnRow.parse(row).name);
  }

  /**
   * `work` in one `BEGIN IMMEDIATE` transaction. Synchronous: call it from a repository operation
   * (gated: it waits for another process's lock) or from start-up code.
   */
  transaction<TResult>(work: () => TResult): TResult {
    if (this.#mutex.isInside)
      throw new IdempotencyError.NestedTransaction({
        message:
          "connection.transaction() was called inside an Idempotency.runOnce: the effect already has its transaction — write through requireTransaction(), so an uncaught error rolls everything back",
      });
    if (this.#attempt.lock()) return joinedTransaction(this.#database, work);
    return inImmediateTransaction(this.#database, work);
  }

  /** Closes the file when the instance stops (its stores are destroyed first: they depend on it). */
  onDestroy(): void {
    if (this.#database.isOpen) this.#database.close();
  }
}

/**
 * The transaction of the `runOnce` the caller is inside of, on whichever file (#1317c): for a
 * repository that holds no `SqliteConnection` of its own. `IdempotencyError.OutsideTransaction`
 * outside one.
 */
export function requireSqliteTransaction(): SqliteTransactionHandle {
  const scope = ambientHoldScope();
  if (scope instanceof SqliteTransactionScope) return scope.handle;
  throw new IdempotencyError.OutsideTransaction({
    message:
      "requireSqliteTransaction() was called outside an Idempotency.runOnce on SQLite: a repository takes the effect's transaction only inside `execute`",
  });
}

/** The SQLite implementations: each needs the storage's `SqliteDriver`; each instance opens its own connection. */
const sqliteImplementations = new WeakSet<Class>();

/**
 * Marks a framework class as a SQLite implementation (internal): never reused by a later app of a
 * test (its rows are in the file, its connection is its instance's). Its file is the
 * `SqliteDriver`'s `path`, which `SqliteConnection` reads from the storage's settings.
 */
export function sqliteImplementation(implementation: Class, options: SqliteGateOptions = {}): void {
  sqliteImplementations.add(implementation);
  gatedSqliteImplementation(implementation, options, (instance) => connectionOf(instance));
}

/** The `SqliteConnection` an implementation's instance holds (one level into its own fields). */
function connectionOf(instance: object): SqliteConnection | undefined {
  for (const value of Object.values(instance)) if (value instanceof SqliteConnection) return value;
  return undefined;
}

/** Whether an instance is of a SQLite implementation or a subclass of one (it keeps nothing outside its file). */
export function isSqliteImplementation(instance: object): boolean {
  for (
    let at: unknown = instance.constructor;
    typeof at === "function";
    at = Object.getPrototypeOf(at)
  ) {
    if (sqliteImplementations.has(at as Class)) return true;
  }
  return false;
}

/**
 * `true` once a statement changed exactly one row (#626): the count of a write whose row its own
 * transaction read first, so any other count is a bug, never a state to handle — an `Error`, as
 * `definedOf` for a value.
 */
export function oneRowChanged(changes: number | bigint): true {
  if (Number(changes) !== 1)
    throw new Error(`unreachable: ${String(changes)} rows changed by a write of a row read first`);
  return true;
}

export { checkSqliteCancel, markedCancelRequested } from "./sqlite-cancel.js";
