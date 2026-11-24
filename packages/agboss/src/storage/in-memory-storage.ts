import type { Class } from "../components/injection.js";
import { hours } from "../units/index.js";
import { DatabaseStorage } from "./storage-decorators.js";
import { SqliteDriver } from "./drivers.js";
import { defineStorageDriver, StorageRole } from "./storage-driver.js";

/**
 * The built-in database storage (#1321): the stores in memory — what an application with no storage
 * has — lost on restart and not shared by processes. For tests and a first run; its audit log and
 * ledger entries are kept 24 hours. It supplies no PII key: with no `piiSecret`, a
 * `tokenize()` fails the start, except under `testWith`, which has a fixed test key of its own.
 */
@DatabaseStorage({
  name: "in-memory-database-storage",
  description: "Every store in memory: lost on restart, not shared by processes",
  driver: defineStorageDriver({
    role: StorageRole.Database,
    backend: "in-memory",
    describes: "in memory",
    settings: { kind: "in-memory" },
    // none listed: the container's built-in in-memory defaults
    providers: [],
  }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
})
export class InMemoryDatabaseStorage {}

/**
 * The database an application with `ChildPlacement.IsolatedWorker` children gets in place of the
 * in-memory one (#1286b): a temporary SQLite file shared by the instance and its forked workers,
 * removed when the process ends. A class of its own for each application, so that two applications of
 * one process never share a file.
 */
export function temporaryFileDatabaseStorage(): Class {
  @DatabaseStorage({
    name: "temporary-file-database-storage",
    description:
      "A temporary SQLite file shared with the isolated workers: gone when the process ends",
    driver: SqliteDriver.inMemory(),
    auditLogTtl: hours(24),
    ledgerEntriesTtl: hours(24),
  })
  class TemporaryFileDatabaseStorage {}
  return TemporaryFileDatabaseStorage;
}
