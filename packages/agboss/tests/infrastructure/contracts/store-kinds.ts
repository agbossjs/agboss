import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createContainer } from "../../../src/components/container/container.js";
import {
  applicationContextOf,
  ApplicationContext,
} from "../../../src/flow/context/application-context.js";
import { resolveEnvironment } from "../../../src/environments/resolve.js";
import type { Token } from "../../../src/components/injection.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import type { ContractTarget, StoreSeam } from "../../../src/testing/contracts/index.js";

/**
 * The core's own stores as targets of the published contract suites (#481,
 * `@agboss/core/testing/contracts`): the built-in in-memory default (two instances over one
 * `InMemoryDatabase`, what `testWith(App, { instances: 2 })` gives) and SQLite (two instances, two
 * connections to one temporary file — so `BEGIN IMMEDIATE` is tested between connections). Both
 * run exactly the cases an external store runs; every test gets a new database or file.
 */

/** What one of the core's stores is built from: the seam, and the backing store of its kind. */
export interface InstanceSeam extends StoreSeam {
  /** The rows of the in-memory defaults, shared by the test's instances. */
  readonly database: InMemoryDatabase;
  /** This instance's own connection to the test's SQLite file. */
  readonly connection: () => SqliteConnection;
}

/** How a kind builds the store of one instance. */
export type StoreFactory<TStore> = (seam: InstanceSeam) => TStore;

const opened: SqliteConnection[] = [];
const folders: string[] = [];

afterEach(() => {
  for (const connection of opened.splice(0)) connection.onDestroy();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A new SQLite file of this test (removed after it). */
export function temporarySqlitePath(): string {
  const folder = mkdtempSync(join(tmpdir(), "agboss-sqlite-"));
  folders.push(folder);
  return join(folder, "application.sqlite");
}

/** The application context of a test instance whose environment names the SQLite file. */
const applicationOn = (path: string, instanceId = "store-test"): ApplicationContext =>
  applicationContextOf({
    name: "store-test-application",
    version: "1.0.0",
    instanceId,
    startedAt: new Date(0),
    environmentName: "test",
    // the SQLite stores read `sqlitePath` only — resolved as an environment file would be
    environment: resolveEnvironment(
      { name: "test", contract: "StoreEnvironment", values: { sqlitePath: path } },
      {},
    ),
  });

/** A connection of this test to `path` as an application's container makes it, closed after it. */
export function connectionTo(path: string): SqliteConnection {
  const container = createContainer({
    modules: [],
    core: new Map<Token, unknown>([[ApplicationContext, applicationOn(path)]]),
  });
  const connection = container.get(SqliteConnection);
  if (!(connection instanceof SqliteConnection)) throw new Error("not a SqliteConnection");
  opened.push(connection);
  return connection;
}

const noConnection = (): never => {
  throw new Error("an in-memory store has no SQLite connection");
};

/** The in-memory default: one `InMemoryDatabase` per test, shared by both instances. */
export function inMemoryTarget<TStore>(make: StoreFactory<TStore>): ContractTarget<TStore> {
  let database = new InMemoryDatabase();
  return {
    name: "in-memory",
    reset: () => {
      database = new InMemoryDatabase();
    },
    instance: (seam) => make({ ...seam, database, connection: noConnection }),
  };
}

/** SQLite: a temporary file per test, one connection per instance (closed after the test). */
export function sqliteTarget<TStore>(make: StoreFactory<TStore>): ContractTarget<TStore> {
  let path = ":memory:";
  let current: SqliteConnection[] = [];
  return {
    name: "SQLite",
    // #533: the explorer resets once per schedule — the last schedule's connections and file go
    reset: () => {
      for (const connection of current) {
        connection.onDestroy();
        opened.splice(opened.indexOf(connection), 1);
      }
      current = [];
      const folder = folders.pop();
      if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
      path = temporarySqlitePath();
    },
    instance: (seam) => {
      const connection = connectionTo(path);
      current.push(connection);
      return make({ ...seam, database: new InMemoryDatabase(), connection: () => connection });
    },
  };
}

/** Both kinds of the core's stores: `describe.each(storeTargets(inMemory, sqlite))`. */
export const storeTargets = <TStore>(
  inMemory: StoreFactory<TStore>,
  sqlite: StoreFactory<TStore>,
): readonly ContractTarget<TStore>[] => [inMemoryTarget(inMemory), sqliteTarget(sqlite)];

const shared = new WeakMap<InMemoryDatabase, Map<string, unknown>>();

/**
 * One store for both instances of a test, as `testWith(App, { instances: 2 })` reuses the first
 * instance's in-memory stores of #261 (checkpoints, records, the ledger, paused executions).
 */
export function sharedInMemory<TStore>(
  seam: InstanceSeam,
  name: string,
  make: () => TStore,
): TStore {
  const stores = shared.get(seam.database) ?? new Map<string, unknown>();
  shared.set(seam.database, stores);
  if (!stores.has(name)) stores.set(name, make());
  // stored by this function under `name`, made by `make`
  return stores.get(name) as TStore;
}
