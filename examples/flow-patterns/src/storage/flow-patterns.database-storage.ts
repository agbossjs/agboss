import { DatabaseStorage, SqliteDriver, defineEnv, env } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { storageSecrets } from "./storage-secrets.env.js";

const databaseEnv = defineEnv({
  /** The one SQLite file of the application (`:memory:` in the tests). */
  path: env("AGBOSS_SQLITE_PATH", { default: ".agboss/flow-patterns.sqlite" }),
});

/**
 * Where the patterns' durable rows go (#265, #1321): the ledger of the tenant and application
 * budgets, the records, the pauses, the checkpoints, the leases and the tree keys, the credit desk's
 * fenced charge and the travel desk's outbound calls — in SQLite, so two pauses wait at once and
 * survive a restart, and another instance on the file continues them. The project's own
 * `PaymentLedgerRepository` shares its connection.
 */
@DatabaseStorage({
  name: "flow-patterns-database-storage",
  driver: SqliteDriver({ path: databaseEnv.path }),
  auditLogTtl: hours(24 * 7),
  ledgerEntriesTtl: hours(24),
  idempotencySecret: storageSecrets.idempotencySecret,
  piiSecret: storageSecrets.piiSecret,
})
export class FlowPatternsDatabaseStorage {}
