import { Injectable } from "../../components/decorators.js";
import { Clock, lazyLoad } from "../clock.js";
import { LazyPausedExecutionRepository } from "../lazy-paused-execution.repository.js";
import type { PausedExecutionRepository } from "../paused-execution.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { preparePauseTables } from "./sqlite-pause-schema.js";

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265 S32, #267 S35, #910): one row
 * per thread of a tenant (#261) — the paused run and the versions it paused under —, one row per
 * pause (`pauses`) and one row per pause and receiver (`pause_notices`, the notices). The tables are
 * made at construction; every change of a pause is one `BEGIN IMMEDIATE` transaction with its
 * notices (`sqlite-pause-store.ts`, loaded at start: the root import stays lean): of two resumes on
 * two instances exactly one records its decision, and a notice is never without its change nor a
 * change without its notice. With `SqliteCheckpointSaver` a pause survives a restart. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqlitePausedExecutionRepository extends LazyPausedExecutionRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    preparePauseTables(connection);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected loadStore(): Promise<PausedExecutionRepository> {
    return lazyLoad(import("./sqlite-pause-store.js")).then(
      ({ SqlitePauseStore }) => new SqlitePauseStore(this.connection, this.clock),
    );
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
