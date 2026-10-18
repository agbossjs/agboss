import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { ENV } from "../../components/environment-token.js";
import type { OnDestroy } from "../../components/container/lifecycle.js";
import { EnvironmentFieldType, requireEnvironmentFields } from "../../environments/contract.js";
import type { Environment } from "../../flow/generated-types.js";

/**
 * The SQLite file of an application instance (#265 S32): one `DatabaseSync` (`node:sqlite`, loaded
 * on first use) on the environment's `sqlitePath`, shared by every SQLite implementation the
 * application lists — two instances open two connections to one file. `journal_mode=WAL` (readers
 * never block the writer), `busy_timeout` (a writer waits for the other's lock), and every atomic
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

/** Opens (creating its folder) a database on `path` with the pragmas every SQLite store relies on. */
export function openSqliteDatabase(path: string, busyTimeout: number = BUSY_TIMEOUT): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const database = new Database(path, { timeout: busyTimeout });
  database.exec(
    `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${String(busyTimeout)}; PRAGMA foreign_keys = ON;`,
  );
  return database;
}

/**
 * `work` in one `BEGIN IMMEDIATE` transaction: the write lock is taken first, so of two connections
 * one waits (up to the busy timeout) and each sees the other's committed rows. Rolled back when
 * `work` throws. `work` is synchronous — nothing else runs on this connection meanwhile.
 */
export function inImmediateTransaction<TResult>(
  database: DatabaseSync,
  work: () => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** The connection of one application instance, created by the container for its SQLite stores. */
@Injectable({ deps: [ENV] })
export class SqliteConnection implements OnDestroy {
  /** The file (`sqlitePath`); `:memory:` keeps the database in this connection only. */
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #prepared = new Set<string>();

  constructor(environment: Environment) {
    const parsed = SqliteEnvironment.safeParse(environment);
    if (!parsed.success) {
      throw new Error(
        `the SQLite implementations need sqlitePath: string in the environment — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    this.path = parsed.data.sqlitePath;
    this.#database = openSqliteDatabase(this.path);
  }

  /** The database itself: for the statements of one store. */
  get database(): DatabaseSync {
    return this.#database;
  }

  /** Runs a store's `CREATE TABLE IF NOT EXISTS …` once per connection (its tables, its indexes). */
  ensureSchema(name: string, ddl: string): void {
    if (this.#prepared.has(name)) return;
    inImmediateTransaction(this.#database, () => {
      this.#database.exec(ddl);
    });
    this.#prepared.add(name);
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
 * Marks a framework class as a SQLite implementation (internal): `[environment.missing-field]` when
 * the application lists it and its contract lacks `sqlitePath`, and never reused by a later app
 * of a test (its rows are in the file, its connection is its instance's).
 */
export function sqliteImplementation(implementation: Class): void {
  sqliteImplementations.add(implementation);
  requireEnvironmentFields(implementation, [
    { field: "sqlitePath", type: EnvironmentFieldType.Text },
  ]);
}

/** Whether an instance is of a SQLite implementation or a subclass of one (it keeps nothing outside its file). */
export function isSqliteImplementation(instance: object): boolean {
  for (let at: unknown = instance.constructor; typeof at === "function"; at = Object.getPrototypeOf(at)) {
    if (sqliteImplementations.has(at as Class)) return true;
  }
  return false;
}
