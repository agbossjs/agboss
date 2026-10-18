import { Injectable } from "../../components/decorators.js";
import { sharedTernStore, type NewThreadId } from "../../terns/index.js";
import { Clock } from "../clock.js";
import { NEW_THREAD_ID } from "../instance-tokens.js";
import { TernStoreRecordRepository } from "../execution-record.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * `ExecutionRecordRepository` on the application's SQLite file (#265, S32): threads, records,
 * scores, summaries and config snapshots in the Tern tables, migrated on first use — so
 * `agboss eval` / `replay` / `golden` and `--thread` see the records of earlier processes, and
 * recovery finds the roots a dead instance left `running`. Status writes that must not land late
 * are compare-and-set (`completeIfStatus`, one statement). Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock, NEW_THREAD_ID] })
export class SqliteExecutionRecordRepository extends TernStoreRecordRepository {
  constructor(connection: SqliteConnection, clock: Clock, newThreadId: NewThreadId | undefined) {
    super(sharedTernStore(connection.database, () => clock.now(), newThreadId));
  }
}

sqliteImplementation(SqliteExecutionRecordRepository);
