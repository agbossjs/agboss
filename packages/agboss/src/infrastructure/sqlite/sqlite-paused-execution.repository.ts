import { Injectable } from "../../components/decorators.js";
import { Clock } from "../clock.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { preparePauseTables } from "./sqlite-pause-schema.js";
import { SqlitePauseStore } from "./sqlite-pause-store.js";

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265 S32, #267 S35, #910): one row
 * per thread of a tenant (#261) — the paused run and the versions it paused under —, one row per
 * pause (`pauses`) and one row per pause and receiver (`pause_notices`, the notices). The tables are
 * made at construction; every change of a pause is one `BEGIN IMMEDIATE` transaction with its
 * notices (`sqlite-pause-store.ts`): of two resumes on two instances exactly one records its
 * decision, and a notice is never without its change nor a change without its notice. With
 * `SqliteCheckpointSaver` a pause survives a restart. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqlitePausedExecutionRepository extends SqlitePauseStore {
  constructor(connection: SqliteConnection, clock: Clock) {
    super(connection, clock);
    preparePauseTables(connection);
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
