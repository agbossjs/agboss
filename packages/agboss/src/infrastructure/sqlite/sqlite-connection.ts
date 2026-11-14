import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import type { OnDestroy } from "../../components/container/lifecycle.js";
import { EnvironmentField } from "../../environments/contract.js";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import { pauseThread } from "../clock.js";
import type { EffectKey } from "../effect-key.js";
import { cancelTreeOf } from "../issued-keys.js";
import { afterFailedCommit, classifiedDatabase } from "./sqlite-outcome.js";

/**
 * The SQLite file of an application instance (#265 S32): one `DatabaseSync` (`node:sqlite`, loaded
 * on first use) on the environment's `sqlitePath`, shared by every SQLite implementation the
 * application lists — two instances open two connections to one file. `journal_mode=WAL` (readers never
 * block the writer; its switch on a new file, tried again while busy, the whole open bounded by the
 * busy timeout, #911), then `busy_timeout` (a writer waits for the other's lock), and every atomic
 * operation in one `BEGIN IMMEDIATE` transaction. The driver is synchronous: a transaction is one
 * group of statements with no `await` inside, and a busy wait blocks this instance's event loop.
 * Time values are parameters from the framework's clock, never SQLite's own.
 */

/** How long a writer waits for another connection's lock before the store fails (milliseconds). */
export const BUSY_TIMEOUT = 5000;

/** What a SQLite implementation reads from the environment: `sqlitePath` (`:memory:` in tests). */
const SqliteEnvironment = z.object({
  sqlitePath: z.string().min(1, "sqlitePath is empty — a file path, or :memory: in tests"),
});

/** One row of `PRAGMA table_info`: a column's name. */
const ColumnRow = z.looseObject({ name: z.string() });

/** One row of `PRAGMA index_list` (its name, whether unique) and of `PRAGMA index_info` (a column). */
const IndexRow = z.looseObject({ name: z.string(), unique: z.number() });
const IndexColumnRow = z.looseObject({ name: z.string().nullable() });

/** SQLite's `SQLITE_BUSY` result code; its extended codes (`SQLITE_BUSY_RECOVERY` = 261, …) keep it in the low byte. */
const SQLITE_BUSY = 5;
const PRIMARY_CODE_MASK = 0xff;

/** The longest pause between two tries of the WAL switch (milliseconds); the pauses start at 1 and double. */
const LONGEST_PAUSE = 50;

/**
 * `PRAGMA journal_mode = WAL` (#911). On a new file, several connections opening it at once make
 * SQLite answer `SQLITE_BUSY` to the switch itself, at once and whatever the busy timeout (its busy
 * handler is not asked where waiting could deadlock) — so a busy answer (any of its extended codes: with the busy timeout at 0, SQLite no longer waits out `SQLITE_BUSY_RECOVERY` itself) is tried again, with a
 * growing pause, for `busyTimeout` in all, then fails as before. The caller sets SQLite's own
 * `busy_timeout` to 0 for these tries: a lock really held on a file not yet in WAL mode would make
 * SQLite wait the whole timeout inside every try, and the pauses counted here would no longer bound
 * the open. With 0, each try returns at once, so the pauses are the whole wait. The pause is a
 * blocking `pauseThread` (no `Clock` drives it): acceptable only because this is synchronous
 * startup, before the instance serves, and the total is bounded by `busyTimeout`.
 */
function switchToWal(database: DatabaseSync, busyTimeout: number): void {
  for (let waited = 0, next = 1; ;) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const isBusy =
        error instanceof Error &&
        "errcode" in error &&
        typeof error.errcode === "number" &&
        (error.errcode & PRIMARY_CODE_MASK) === SQLITE_BUSY;
      if (!isBusy || waited >= busyTimeout) throw error;
      const length = Math.min(next, busyTimeout - waited);
      pauseThread(length);
      waited += length;
      next = Math.min(next * 2, LONGEST_PAUSE);
    }
  }
}

/**
 * Opens (creating its folder) a database on `path` with the pragmas every SQLite store relies on.
 * The whole open — every try of the WAL switch included — is bounded by `busyTimeout` (#911): the
 * switch runs with SQLite's own busy timeout at 0, which is set to `busyTimeout` once it is done.
 */
export function openSqliteDatabase(path: string, busyTimeout: number = BUSY_TIMEOUT): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const database = new Database(path, { timeout: 0 });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    switchToWal(database, busyTimeout);
    database.exec(`PRAGMA busy_timeout = ${String(busyTimeout)}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
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

/**
 * The SQLite connection of one application instance: created only by the container, shared by its
 * SQLite stores — and the DI token a subclass of a SQLite implementation names in its `deps`
 * (`@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })`, #265 S70; a fencing
 * store's — the lease, fenced-effect and outbound-call stores — `[SqliteConnection, StoreClock,
 * ApplicationContext]`, #847: a `Clock` does not pass for its `StoreClock`).
 */
@Injectable({
  deps: [ApplicationContext],
  environmentFields: { sqlitePath: EnvironmentField.text() },
})
export class SqliteConnection implements OnDestroy {
  /** The file (`sqlitePath`); `:memory:` keeps the database in this connection only. */
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #prepared = new Set<string>();

  constructor(applicationContext: ApplicationContext) {
    const parsed = SqliteEnvironment.safeParse(applicationContext.environment);
    if (!parsed.success) {
      throw new Error(
        `the SQLite implementations need sqlitePath: string in the environment — ${parsed.error.issues.map((issue) => issue.message).join("; ")}; set it in the environment's file, or in a unit test pass it: testAction(X, { environment: { sqlitePath: ":memory:" } })`,
      );
    }
    this.path = parsed.data.sqlitePath;
    this.#database = classifiedDatabase(openSqliteDatabase(this.path));
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
    return new Promise<void>((resolve) => {
      this.#database.prepare("SELECT 1").get();
      resolve();
    });
  }

  /** Runs a store's `CREATE TABLE IF NOT EXISTS …` once per connection (its tables, its indexes). */
  ensureSchema(name: string, ddl: string): void {
    if (this.#prepared.has(name)) return;
    inImmediateTransaction(this.#database, () => {
      this.#database.exec(ddl);
    });
    this.#prepared.add(name);
  }

  /** The columns a table of this file has now (none when it does not exist). */
  columnsOf(table: string): readonly string[] {
    return this.#database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => ColumnRow.parse(row).name);
  }

  /** The unique indexes of a table of this file, each as its columns joined by `,` (#663). */
  uniqueIndexesOf(table: string): readonly string[] {
    const columnsOf = (index: string): string =>
      this.#database
        .prepare(`PRAGMA index_info("${index}")`)
        .all()
        .map((row) => IndexColumnRow.parse(row).name)
        .join(",");
    return this.#database
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .map((row) => IndexRow.parse(row))
      .filter((index) => index.unique === 1)
      .map((index) => columnsOf(index.name));
  }

  /**
   * A migration of a file an older version wrote: adds `column` to `table` when it lacks it (checked
   * inside the transaction, so of two connections one adds it), nothing otherwise.
   */
  addColumn(table: string, column: string, definition: string): void {
    inImmediateTransaction(this.#database, () => {
      if (this.columnsOf(table).includes(column)) return;
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });
  }

  /** `work` in one `BEGIN IMMEDIATE` transaction on this connection. */
  transaction<TResult>(work: () => TResult): TResult {
    return inImmediateTransaction(this.#database, work);
  }

  /** Closes the file when the instance stops (its stores are destroyed first: they depend on it). */
  onDestroy(): void {
    if (this.#database.isOpen) this.#database.close();
  }
}

/** The SQLite implementations: listed, each needs `sqlitePath`; each instance opens its own connection. */
const sqliteImplementations = new WeakSet<Class>();

/**
 * Marks a framework class as a SQLite implementation (internal): never reused by a later app of a
 * test (its rows are in the file, its connection is its instance's). Its `sqlitePath` is
 * `SqliteConnection`'s declared field (#511), checked through the class's `deps`.
 */
export function sqliteImplementation(implementation: Class): void {
  sqliteImplementations.add(implementation);
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

/**
 * The cancel mark on a SQLite file (#909): the table `execution_cancel_requests` is created with the
 * leases' (`EXECUTION_LEASES_SCHEMA`), written by the lease store's `requestCancel` and read by both
 * fencing stores inside their own `BEGIN IMMEDIATE` transactions — which an `INSERT OR IGNORE` in a
 * `BEGIN IMMEDIATE` of its own serializes with.
 */

/** Marks the tree's cancel at `now` (ms): once, a repeat changes nothing. */
export function markedCancelRequested(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  now: number,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO execution_cancel_requests (tenant_id, root_execution_id, requested_at) VALUES (?, ?, ?)",
    )
    .run(tree.tenantId, tree.rootExecutionId, now);
}

/**
 * The cancel check of the SQLite stores, inside the caller's transaction: the key's tree has a
 * cancel request and the key is not an undo's → `ExecutionCancelFencedError`, nothing written or
 * sent. After the lease and mark checks and, for an effect, after the key's lookup.
 */
export function checkSqliteCancel(database: DatabaseSync, key: EffectKey): void {
  if (key.isCompensation === true) return;
  const { tenantId, rootExecutionId } = cancelTreeOf(key);
  const found = database
    .prepare(
      "SELECT 1 AS found FROM execution_cancel_requests WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(tenantId, rootExecutionId);
  if (found !== undefined) throw ExecutionCancelFencedError.of(key);
}

/**
 * Removes the cancel requests older than `before` (ms) whose tree is over — its lease retired
 * (`released = 3`, #520): the fencing stores' retention. Never by age alone: a tree not over
 * (paused longer than the retention, resumed on another instance) keeps its mark.
 */
export function prunedCancelRequests(database: DatabaseSync, before: number): void {
  database
    .prepare(
      `DELETE FROM execution_cancel_requests WHERE requested_at < ? AND EXISTS (
         SELECT 1 FROM execution_leases AS leases
         WHERE leases.tenant_id = execution_cancel_requests.tenant_id
           AND leases.root_execution_id = execution_cancel_requests.root_execution_id
           AND leases.released = 3)`,
    )
    .run(before);
}
