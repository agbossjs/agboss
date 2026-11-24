import { hours } from "../units/index.js";
import { DatabaseStorage } from "./storage-decorators.js";
import { defineStorageDriver, StorageRole } from "./storage-driver.js";

/**
 * The built-in database storage (#1321): the stores in memory — what an application with no storage
 * has — lost on restart and not shared by processes. For tests and a first run; its audit log and
 * ledger entries are kept 24 hours.
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
