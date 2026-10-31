import type { DatabaseSync } from "node:sqlite";
import {
  env,
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
} from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";

/**
 * #484 — the core's own store set under the fault suite: every SQLite store on one file that
 * several pods (processes) open, the way two instances share a file on one disk. The business rows
 * of the fixture's charge are a table of that file, written in the fenced effect's `BEGIN
 * IMMEDIATE` transaction (synchronously, as the SQLite store's work must be).
 */

/** The table of the fixture's business rows. */
const BUSINESS_ROWS = "CREATE TABLE IF NOT EXISTS fault_business_rows (row TEXT NOT NULL)";

/** The environment the SQLite stores read: the file every pod opens. */
export class SqliteFaultEnvironment {
  sqlitePath!: string;
}

export const sqliteFaultStoreClasses = [
  SqliteConnection,
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
];

export const faultStores = defineFaultStores<DatabaseSync>({
  providers: sqliteFaultStoreClasses,
  environment: {
    contract: SqliteFaultEnvironment,
    values: { sqlitePath: env("AGBOSS_FAULT_DATABASE_URL") },
  },
  businessRows: {
    insert: (database, row) => {
      database.exec(BUSINESS_ROWS);
      database.prepare("INSERT INTO fault_business_rows (row) VALUES (?)").run(row);
    },
    committed: (app) => {
      const { database } = app.resolve(SqliteConnection);
      database.exec(BUSINESS_ROWS);
      const rows = database.prepare("SELECT row FROM fault_business_rows ORDER BY rowid").all();
      return Promise.resolve(rows.map((found) => String(found.row)));
    },
  },
});
