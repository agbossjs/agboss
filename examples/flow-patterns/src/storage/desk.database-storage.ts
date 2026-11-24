import { DatabaseStorage, SqliteDriver, defineEnv, env } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { storageSecrets } from "./storage-secrets.env.js";

const databaseEnv = defineEnv({
  /** The desk's SQLite file (`:memory:` in the tests); its kept executions outlive the run. */
  path: env("AGBOSS_SQLITE_PATH", { default: ".agboss/desk-offline.sqlite" }),
});

/**
 * Where the offline desk's rows go: SQLite at `.agboss/desk-offline.sqlite` (git-ignored), so its
 * kept executions (`retention.executionRecords`, #401) outlive the run — `agboss records export`
 * and `agboss generate eval-case --from-execution` read them. The desk writes under no business key,
 * so it names no idempotency secret; its PII policy needs the PII key.
 */
@DatabaseStorage({
  name: "desk-database-storage",
  driver: SqliteDriver({ path: databaseEnv.path }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
  piiSecret: storageSecrets.piiSecret,
})
export class DeskDatabaseStorage {}
