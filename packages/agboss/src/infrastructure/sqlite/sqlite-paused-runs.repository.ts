import type { PausedExecution } from "../../app/paused-runs.js";
import { Clock } from "../clock.js";
import { PausedExecutionRepository } from "../paused-execution.repository.js";
import { migratePauses } from "./sqlite-pause-migrations.js";
import { SqlitePauseNoticeRows } from "./sqlite-pause-notice-rows.js";
import { NOTICES_SCHEMA } from "./sqlite-pause-notice-schema.js";
import { PAUSES_SCHEMA, SqlitePauseRows } from "./sqlite-pause-rows.js";
import { SqlitePauseScans } from "./sqlite-pause-scans.js";
import type { SqliteConnection } from "./sqlite-connection.js";
import {
  PAUSE_RECORDS_MIGRATION,
  PAUSED_RUNS_SCHEMA,
  SqlitePausedRunRows,
  TENANT_MIGRATION,
} from "./sqlite-paused-run-rows.js";

/**
 * The first layer of `SqlitePausedExecutionRepository`: the file's tables made and migrated, the
 * statements of each, and the paused runs. The pauses' changes and the notices are the layers above.
 */
export abstract class SqlitePausedRunRepository extends PausedExecutionRepository {
  protected readonly runs: SqlitePausedRunRows;
  protected readonly pauses: SqlitePauseRows;
  protected readonly notices: SqlitePauseNoticeRows;
  protected readonly scans: SqlitePauseScans;

  constructor(
    protected readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    connection.transaction(() => {
      const columns = connection.columnsOf("paused_executions");
      if (columns.length > 0 && !columns.includes("tenant_id"))
        connection.database.exec(TENANT_MIGRATION);
      else if (columns.includes("status")) connection.database.exec(PAUSE_RECORDS_MIGRATION);
      migratePauses(connection);
    });
    connection.ensureSchema("paused_executions", PAUSED_RUNS_SCHEMA);
    connection.ensureSchema("pauses", PAUSES_SCHEMA);
    connection.ensureSchema("pause_notices", NOTICES_SCHEMA);
    const { database } = connection;
    this.runs = new SqlitePausedRunRows(database);
    this.pauses = new SqlitePauseRows(database);
    this.notices = new SqlitePauseNoticeRows(database);
    this.scans = new SqlitePauseScans(database);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    return Promise.resolve(this.runs.find(tenantId, threadId));
  }

  save(paused: PausedExecution): Promise<void> {
    this.runs.save(paused, this.clock.now());
    return Promise.resolve();
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    this.runs.delete(tenantId, threadId);
    return Promise.resolve();
  }

  deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    this.runs.deleteOfRun(tenantId, threadId, runId);
    return Promise.resolve();
  }
}
