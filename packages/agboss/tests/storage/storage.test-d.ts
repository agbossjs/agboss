import { describe, expectTypeOf, it } from "vitest";
import {
  ClusterStorage,
  DatabaseStorage,
  ObjectStorage,
  SqliteDriver,
  S3Driver,
  LocalDiskDriver,
  InMemoryObjectDriver,
  Ttl,
  type ApplicationOptions,
  type ClusterDriver,
  type DatabaseDriver,
  type DatabaseStorageOptions,
  type ObjectDriver,
} from "../../src/index.js";
import type * as Stores from "../../src/stores/index.js";
import type * as Root from "../../src/index.js";
import type { Milliseconds } from "../../src/units/index.js";

/** #1321a / #1324c: the storage components, their drivers and where they are listed. */
describe("#1321a: the storage components", () => {
  it("every driver is the descriptor of its role", () => {
    expectTypeOf(SqliteDriver({ path: "x" })).toEqualTypeOf<DatabaseDriver>();
    expectTypeOf(SqliteDriver.inMemory()).toEqualTypeOf<DatabaseDriver>();
    expectTypeOf(S3Driver({ bucket: "b" })).toEqualTypeOf<ObjectDriver>();
    expectTypeOf(LocalDiskDriver({ directory: "d" })).toEqualTypeOf<ObjectDriver>();
    expectTypeOf(InMemoryObjectDriver()).toEqualTypeOf<ObjectDriver>();
  });

  it("a driver of another role is a compile error", () => {
    const objects = S3Driver({ bucket: "b" });
    // @ts-expect-error an object driver is no database driver
    const wrong: DatabaseStorageOptions["driver"] = objects;
    expectTypeOf(wrong).not.toBeAny();
    // @ts-expect-error a literal is no driver: only the factories make one
    const literal: DatabaseStorageOptions["driver"] = { role: "database", backend: "x" };
    expectTypeOf(literal).not.toBeAny();
  });

  it("the two ttls are required, and the ledger's takes no Ttl.None", () => {
    expectTypeOf<DatabaseStorageOptions["auditLogTtl"]>().toEqualTypeOf<
      Milliseconds | Ttl.Forever | Ttl.None
    >();
    expectTypeOf<DatabaseStorageOptions["ledgerEntriesTtl"]>().toEqualTypeOf<
      Milliseconds | Ttl.Forever
    >();
    expectTypeOf<DatabaseStorageOptions>().toHaveProperty("auditLogTtl");
  });

  it("@Application takes storage: the database alone or all three", () => {
    expectTypeOf<ApplicationOptions["storage"]>().not.toBeNever();
    expectTypeOf<ApplicationOptions>().toHaveProperty("storage");
  });

  it("the decorators are in the root and SqliteConnection moved to /stores", () => {
    expectTypeOf(DatabaseStorage).toBeFunction();
    expectTypeOf(ClusterStorage).toBeFunction();
    expectTypeOf(ObjectStorage).toBeFunction();
    expectTypeOf<ClusterDriver>().not.toBeAny();
    expectTypeOf<Stores.StorageDriver>().not.toBeAny();
    expectTypeOf<typeof Stores.defineStorageDriver>().toBeFunction();
    expectTypeOf<Stores.SqliteConnection>().not.toBeAny();
    expectTypeOf<Root.ApplicationStorage>().not.toBeAny();
    expectTypeOf<keyof typeof Root>().not.toEqualTypeOf<"SqliteConnection">();
  });
});
