import type { Class } from "../../../../src/components/injection.js";
import { DatabaseStorage, SqliteDriver, env, secret } from "../../../../src/index.js";
import { defineStorageDriver, StorageRole } from "../../../../src/storage/storage-driver.js";
import { hours } from "../../../../src/units/index.js";

/**
 * The SQLite fixtures' database (#1324b): the file their SQLite stores share — the test's
 * (`AGBOSS_SQLITE_TEST_PATH`, set per test file), else a database in memory. The storage provides
 * every SQLite store, so a fixture lists none of them.
 */
export interface SqliteTestStorageOptions {
  /**
   * Store classes of the fixture that take the place of the driver's own — a subclass of one
   * (`MortalSqliteExecutionLeaseRepository`), or one the driver does not list; the driver's store
   * the class extends is left out.
   */
  readonly replace?: readonly Class[];
  /**
   * Only these stores of the driver (the classes `replace` swaps for subclasses included) — what a
   * fixture that lists a few SQLite stores and leaves the rest to the in-memory defaults had.
   */
  readonly only?: readonly Class[];
  /** The variable the file's path is read from (default `AGBOSS_SQLITE_TEST_PATH`, `:memory:` when unset). */
  readonly pathVariable?: string;
  /**
   * Whether the storage names an idempotency secret, `AGBOSS_SQLITE_TEST_IDEMPOTENCY` (default: it
   * does): `testWith` gives the test's keys when the variable is not set, `createApp` needs it set.
   */
  readonly keyed?: boolean;
}

let count = 0;

/** A `@DatabaseStorage` on the test's SQLite file, with the fixture's own store classes in the driver's place. */
export function sqliteTestStorage(options: SqliteTestStorageOptions = {}): Class {
  const base = SqliteDriver({
    path:
      options.pathVariable === undefined
        ? env("AGBOSS_SQLITE_TEST_PATH", { default: ":memory:" })
        : env(options.pathVariable),
  });
  const replacements = options.replace ?? [];
  const classOf = (provider: unknown): Class | undefined =>
    typeof provider === "function" ? (provider as Class) : undefined;
  const replacementOf = (store: Class): Class =>
    replacements.find((one) => one === store || one.prototype instanceof store) ?? store;
  const replaced = base.providers
    .filter((provider) => {
      const store = classOf(provider);
      return options.only === undefined || (store !== undefined && options.only.includes(store));
    })
    .map((provider) => {
      const store = classOf(provider);
      return store === undefined ? provider : replacementOf(store);
    });
  const extra = replacements.filter((one) => !replaced.includes(one));
  const driver = defineStorageDriver({
    role: StorageRole.Database,
    backend: base.backend,
    describes: base.describes,
    settings: base.settings,
    providers: [...replaced, ...extra],
    coordinationStores: base.coordinationStores?.map(replacementOf),
    leaseStore: base.leaseStore === undefined ? undefined : replacementOf(base.leaseStore),
  });
  count += 1;
  @DatabaseStorage({
    name: `sqlite-test-storage-${String(count)}`,
    driver,
    auditLogTtl: hours(24),
    ledgerEntriesTtl: hours(24),
    ...(options.keyed === false
      ? {}
      : { idempotencySecret: secret("AGBOSS_SQLITE_TEST_IDEMPOTENCY") }),
  })
  class SqliteTestStorage {}
  return SqliteTestStorage;
}
