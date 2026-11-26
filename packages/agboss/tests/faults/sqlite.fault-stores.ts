import type { DatabaseSync } from "node:sqlite";
import {
  env,
  SqliteChildExecutionQueueRepository,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionAuditLogRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
} from "../../src/index.js";
import { SqliteCheckpointSaver } from "../../src/internal.js";
import {
  requireSqliteTransaction,
  SqliteConnection,
} from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteA2ATaskRepository } from "../../src/stores/index.js";
import { FaultStoreTime, type FaultStoreSet } from "../../src/testing/faults/index.js";

/**
 * #484 — the core's own store set under the fault suite: every SQLite store on one file that
 * several pods (processes) open, the way two instances share a file on one disk. The business rows
 * of the fixture's charge are a table of that file, written in the fenced effect's `BEGIN
 * IMMEDIATE` transaction (synchronously, as the SQLite store's work must be). It keeps A2A tasks too
 * (#811 AC4): its pods serve the fixture over A2A, and the A2A scenarios run.
 */

/** The table of the fixture's business rows. */
const BUSINESS_ROWS = "CREATE TABLE IF NOT EXISTS fault_business_rows (row TEXT NOT NULL)";

export const sqliteFaultStoreClasses = [
  SqliteConnection,
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionAuditLogRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
  // #811 AC4: the A2A tasks on the same file — the pods serve the fixture over A2A
  SqliteA2ATaskRepository,
];

export const faultStores: FaultStoreSet = {
  providers: sqliteFaultStoreClasses,
  // the SQLite stores read the pod's clock: the history runs at the suite's timeScale (#799)
  storeTime: FaultStoreTime.Host,
  // the file every pod opens: the stores read it from the storage's `SqliteDriver` settings
  storage: {
    backend: "sqlite",
    settings: { kind: "sqlite", path: env("AGBOSS_FAULT_DATABASE_URL") },
  },
  businessRows: {
    insert: (row) => {
      const transaction = requireSqliteTransaction();
      transaction.exec(BUSINESS_ROWS);
      transaction.prepare("INSERT INTO fault_business_rows (row) VALUES (?)").run(row);
    },
    committed: (app) => {
      const { database } = app.resolve(SqliteConnection);
      // a read only: creating the table here would take the file's write lock, which another pod's
      // open transaction holds (`busy_timeout` is 0: "database is locked") — no charge, no table yet
      const table = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fault_business_rows'",
        )
        .get();
      if (table === undefined) return Promise.resolve([]);
      const rows = database.prepare("SELECT row FROM fault_business_rows ORDER BY rowid").all();
      return Promise.resolve(rows.map((found) => String(found.row)));
    },
  },
};
