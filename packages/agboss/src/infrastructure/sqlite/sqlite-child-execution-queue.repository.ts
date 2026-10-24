import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { Clock } from "../clock.js";
import {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type QueuedChildExecution,
} from "../child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../execution-record.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS child_execution_queue (
  tenant_id TEXT NOT NULL, execution_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
  parent_execution_id TEXT NOT NULL, root_workflow TEXT NOT NULL, workflow TEXT NOT NULL,
  depth INTEGER NOT NULL, status TEXT NOT NULL, run TEXT NOT NULL, queued_at INTEGER NOT NULL,
  instance_id TEXT, claimed_at INTEGER, ended_at INTEGER, failure TEXT,
  PRIMARY KEY (tenant_id, execution_id));
CREATE INDEX IF NOT EXISTS child_execution_queue_claims
  ON child_execution_queue (status, depth DESC, queued_at);`;

const STATUSES = Object.values(ExecutionRecordStatus) as [
  ExecutionRecordStatus,
  ...ExecutionRecordStatus[],
];

const QueueRow = z.object({
  tenant_id: z.string(),
  execution_id: z.string(),
  root_execution_id: z.string(),
  parent_execution_id: z.string(),
  root_workflow: z.string(),
  workflow: z.string(),
  depth: z.number(),
  status: z.enum(STATUSES),
  run: z.string(),
  queued_at: z.number(),
  instance_id: z.string().nullable(),
  claimed_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  failure: z.string().nullable(),
});

const dateOf = (millis: number | null): Date | undefined =>
  millis === null ? undefined : new Date(millis);

/** A row as the contract gives it back. */
function childOf(row: unknown): QueuedChildExecution {
  const parsed = QueueRow.parse(row);
  return {
    tenantId: parsed.tenant_id,
    executionId: parsed.execution_id,
    rootExecutionId: parsed.root_execution_id,
    parentExecutionId: parsed.parent_execution_id,
    rootWorkflow: parsed.root_workflow,
    workflow: parsed.workflow,
    depth: parsed.depth,
    status: parsed.status,
    run: parsed.run,
    queuedAt: new Date(parsed.queued_at),
    instanceId: parsed.instance_id ?? undefined,
    claimedAt: dateOf(parsed.claimed_at),
    endedAt: dateOf(parsed.ended_at),
    failure: parsed.failure ?? undefined,
  };
}

/**
 * `ChildExecutionQueueRepository` on the application's SQLite file (#333 PR 2): one row per queued
 * child. A claim reads the first `queued` row (the deepest, then the longest waiting) and marks it
 * `running` for this instance in one `BEGIN IMMEDIATE` transaction, so of two instances on one file
 * exactly one claims a child; a completion is one statement matching this instance's running row.
 * Times are the framework clock's milliseconds. Listed in `@Application({ providers })`; needs
 * `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class SqliteChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
    connection.ensureSchema("child_execution_queue", SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(
        `INSERT OR IGNORE INTO child_execution_queue VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        child.tenantId,
        child.executionId,
        child.rootExecutionId,
        child.parentExecutionId,
        child.rootWorkflow,
        child.workflow,
        child.depth,
        ExecutionRecordStatus.Queued,
        child.run,
        child.queuedAt.getTime(),
      );
    return Promise.resolve(Number(changes) === 1);
  }

  findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const row = this.connection.database
      .prepare("SELECT * FROM child_execution_queue WHERE tenant_id = ? AND execution_id = ?")
      .get(tenantId, executionId);
    return Promise.resolve(row === undefined ? undefined : childOf(row));
  }

  claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const { database } = this.connection;
    const now = this.clock.now().getTime();
    const { instanceId } = this.applicationContext;
    const claimed = this.connection.transaction((): QueuedChildExecution | undefined => {
      const row = database
        .prepare(
          `SELECT * FROM child_execution_queue WHERE status = ?
           ORDER BY depth DESC, queued_at LIMIT 1`,
        )
        .get(ExecutionRecordStatus.Queued);
      if (row === undefined) return undefined;
      const child = childOf(row);
      database
        .prepare(
          `UPDATE child_execution_queue SET status = ?, instance_id = ?, claimed_at = ?
           WHERE tenant_id = ? AND execution_id = ?`,
        )
        .run(ExecutionRecordStatus.Running, instanceId, now, child.tenantId, child.executionId);
      return {
        ...child,
        status: ExecutionRecordStatus.Running,
        instanceId,
        claimedAt: new Date(now),
      };
    });
    return Promise.resolve(claimed);
  }

  completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(
        `UPDATE child_execution_queue SET status = ?, ended_at = ?, failure = ?
         WHERE tenant_id = ? AND execution_id = ? AND status = ? AND instance_id = ?`,
      )
      .run(
        end.status,
        this.clock.now().getTime(),
        end.failure ?? null,
        tenantId,
        executionId,
        ExecutionRecordStatus.Running,
        this.applicationContext.instanceId,
      );
    return Promise.resolve(Number(changes) === 1);
  }

  deleteAllByTenantIdAndRootExecutionId(tenantId: string, rootExecutionId: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM child_execution_queue WHERE tenant_id = ? AND root_execution_id = ?")
      .run(tenantId, rootExecutionId);
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteChildExecutionQueueRepository);
