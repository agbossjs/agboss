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
import { VirtualClock } from "../../../src/testing/clock.js";

/**
 * One shared contract suite per storage contract (#265 PR 3), run against each kind of store: the
 * built-in in-memory default (two instances over one `InMemoryDatabase`, what `testWith(App, {
 * instances: 2 })` gives) and SQLite (two instances, two connections to one temporary file — so
 * `BEGIN IMMEDIATE` is tested between connections). Every test gets a new file, removed after it.
 */

/** What one application instance's store is built from. */
export interface InstanceSeam {
  readonly clock: VirtualClock;
  readonly instanceId: string;
  /** The instance's application context: its `instanceId` (the holder of its leases). */
  readonly application: ApplicationContext;
  /** The rows of the in-memory defaults, shared by the instances. */
  readonly database: InMemoryDatabase;
  /** This instance's own connection to the test's SQLite file. */
  readonly connection: () => SqliteConnection;
}

/** The two instances of one test, over one clock. */
export interface TwoInstances<TStore> {
  readonly clock: VirtualClock;
  readonly first: TStore;
  readonly second: TStore;
}

/** A kind of store the suite runs against. */
export interface StoreKind<TStore> {
  readonly name: string;
  readonly twoInstances: () => TwoInstances<TStore>;
}

/** How each kind builds the store of one instance. */
export interface StoreFactories<TStore> {
  readonly inMemory: (seam: InstanceSeam) => TStore;
  readonly sqlite: (seam: InstanceSeam) => TStore;
}

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

function inMemoryKind<TStore>(make: StoreFactories<TStore>["inMemory"]): StoreKind<TStore> {
  return {
    name: "in-memory",
    twoInstances: () => {
      const clock = new VirtualClock();
      const database = new InMemoryDatabase();
      const seam = (instanceId: string): InstanceSeam => ({
        clock,
        instanceId,
        application: applicationOn(":memory:", instanceId),
        database,
        connection: noConnection,
      });
      return { clock, first: make(seam("instance-1")), second: make(seam("instance-2")) };
    },
  };
}

function sqliteKind<TStore>(make: StoreFactories<TStore>["sqlite"]): StoreKind<TStore> {
  return {
    name: "SQLite",
    twoInstances: () => {
      const clock = new VirtualClock();
      const path = temporarySqlitePath();
      const seam = (instanceId: string): InstanceSeam => {
        const connection = connectionTo(path);
        return {
          clock,
          instanceId,
          application: applicationOn(path, instanceId),
          database: new InMemoryDatabase(),
          connection: () => connection,
        };
      };
      return { clock, first: make(seam("instance-1")), second: make(seam("instance-2")) };
    },
  };
}

/** The kinds a contract suite runs against: `describe.each(storeKinds({ inMemory, sqlite }))`. */
export const storeKinds = <TStore>(make: StoreFactories<TStore>): readonly StoreKind<TStore>[] => [
  inMemoryKind(make.inMemory),
  sqliteKind(make.sqlite),
];

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
