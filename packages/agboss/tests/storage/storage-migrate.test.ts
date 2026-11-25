/**
 * #1321f: `agboss migrate db` runs the migration of the application's database driver on its
 * resolved settings, with the process's variables read once and `allowLiveLeases` only from the
 * command; a driver with no migration (SQLite) migrates nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseStorage, SqliteDriver } from "../../src/index.js";
import { env } from "../../src/environments/index.js";
import { assembledStorageOf } from "../../src/storage/storage-assembly.js";
import { migratedDatabaseOf } from "../../src/storage/storage-migrate.js";
import { defineStorageDriver, StorageRole } from "../../src/stores/index.js";
import { days } from "../../src/units/index.js";

const migrate = vi.fn((_settings: unknown, _options: unknown) =>
  Promise.resolve({ applied: ["0001_baseline_0_1_1"] }),
);

const driver = defineStorageDriver({
  role: StorageRole.Database,
  backend: "fake-sql",
  describes: "fake",
  settings: { kind: "fake-sql", url: env("FAKE_URL") },
  providers: [],
  migrate,
});

@DatabaseStorage({ driver, auditLogTtl: days(1), ledgerEntriesTtl: days(1) })
class FakeDatabaseStorage {}

@DatabaseStorage({
  driver: SqliteDriver({ path: ":memory:" }),
  auditLogTtl: days(1),
  ledgerEntriesTtl: days(1),
})
class SqliteDatabaseStorage {}

describe("#1321f: migratedDatabaseOf", () => {
  it("runs the driver's migration on its settings read from the process's variables", async () => {
    migrate.mockClear();

    const run = await migratedDatabaseOf(
      assembledStorageOf(FakeDatabaseStorage),
      { FAKE_URL: "fake://db" },
      { allowLiveLeases: false },
    );

    expect(run).toEqual({ backend: "fake-sql", applied: ["0001_baseline_0_1_1"] });
    expect(migrate).toHaveBeenCalledExactlyOnceWith(
      { kind: "fake-sql", url: "fake://db" },
      { allowLiveLeases: false },
    );
  });

  it("allowLiveLeases is the command's alone, passed as given", async () => {
    migrate.mockClear();

    await migratedDatabaseOf(
      assembledStorageOf(FakeDatabaseStorage),
      { FAKE_URL: "x" },
      { allowLiveLeases: true },
    );

    expect(migrate.mock.calls[0]?.[1]).toEqual({ allowLiveLeases: true });
  });

  it("a driver's refusal passes as it is", async () => {
    migrate.mockRejectedValueOnce(new Error("store.live-leases"));

    await expect(
      migratedDatabaseOf(
        assembledStorageOf(FakeDatabaseStorage),
        { FAKE_URL: "x" },
        {
          allowLiveLeases: false,
        },
      ),
    ).rejects.toThrow("store.live-leases");
  });

  it("a driver with no migration, or no database storage, migrates nothing", async () => {
    const none = { allowLiveLeases: false };

    expect(await migratedDatabaseOf(assembledStorageOf(SqliteDatabaseStorage), {}, none)).toBe(
      undefined,
    );
    expect(await migratedDatabaseOf(undefined, {}, none)).toBe(undefined);
  });
});
