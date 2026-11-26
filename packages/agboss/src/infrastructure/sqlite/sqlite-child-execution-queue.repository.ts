import { childOf, dateOf, DepthRow } from "./sqlite-child-queue-rows.js";
import { isolatedClaimOf, queuedIsolatedOf } from "./sqlite-isolated-claim.js";
import { Injectable } from "../../components/decorators.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { Clock } from "../clock.js";
import {
  ChildExecutionQueueRepository,
  type ChildExecutionEnd,
  type ChildExecutionQueueCounts,
  type QueuedChildExecution,
} from "../child-execution-queue.repository.js";
import { ChildPlacement } from "../../flow/child-placement.js";
import { ExecutionRecordStatus } from "../execution-record.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * `ChildExecutionQueueRepository` on the application's SQLite file (#333 PR 2): one row per queued
 * child. A claim reads the first `queued` row (the deepest, then the longest waiting) and marks it
 * `running` for this instance in one `BEGIN IMMEDIATE` transaction, so of two instances on one file
 * exactly one claims a child; a completion is one statement matching this instance's running row.
 * Times are the framework clock's milliseconds. Listed in `@Application({ providers })`; needs
 * the application's `SqliteDriver` storage.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class SqliteChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const { database } = this.connection;
    const saved = this.connection.transaction((): boolean => {
      const inserted = database
        .prepare(
          `INSERT OR IGNORE INTO child_execution_queue
           (tenant_id, execution_id, root_execution_id, parent_execution_id, root_workflow, workflow,
            depth, status, run, queued_at, placement, exclude_instance_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          child.placement ?? null,
          child.excludeInstanceId ?? null,
        );
      if (Number(inserted.changes) === 1) return true;
      const updated = database
        .prepare(
          `UPDATE child_execution_queue
           SET status = ?, run = ?, queued_at = ?, instance_id = NULL, claimed_at = NULL,
               ended_at = NULL, failure = NULL, placement = ?, exclude_instance_id = ?
           WHERE tenant_id = ? AND execution_id = ?
             AND (status = ? OR (status = ? AND claimed_at = ?))`,
        )
        .run(
          ExecutionRecordStatus.Queued,
          child.run,
          child.queuedAt.getTime(),
          child.placement ?? null,
          child.excludeInstanceId ?? null,
          child.tenantId,
          child.executionId,
          ExecutionRecordStatus.Paused,
          ExecutionRecordStatus.Running,
          child.claimedAt === undefined ? -1 : child.claimedAt.getTime(),
        );
      return Number(updated.changes) === 1;
    });
    return Promise.resolve(saved);
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
             AND (placement IS NULL OR placement <> ?)
             AND (exclude_instance_id IS NULL OR exclude_instance_id <> ?)
           ORDER BY depth DESC, queued_at LIMIT 1`,
        )
        .get(ExecutionRecordStatus.Queued, ChildPlacement.IsolatedWorker, instanceId);
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

  findQueuedIsolatedWorkerChildren(limit: number): Promise<readonly QueuedChildExecution[]> {
    return Promise.resolve(queuedIsolatedOf(this.connection.database, limit));
  }

  claimIsolatedWorkerByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const at = this.clock.now().getTime();
    const claim = { tenantId, executionId, instanceId: this.applicationContext.instanceId, at };
    return Promise.resolve(
      this.connection.transaction(() => isolatedClaimOf(this.connection, claim)),
    );
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

  withdrawByTenantIdAndExecutionIdIfQueued(
    tenantId: string,
    executionId: string,
  ): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(
        "DELETE FROM child_execution_queue WHERE tenant_id = ? AND execution_id = ? AND status = ?",
      )
      .run(tenantId, executionId, ExecutionRecordStatus.Queued);
    return Promise.resolve(Number(changes) === 1);
  }

  deleteAllByTenantIdAndRootExecutionId(tenantId: string, rootExecutionId: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM child_execution_queue WHERE tenant_id = ? AND root_execution_id = ?")
      .run(tenantId, rootExecutionId);
    return Promise.resolve();
  }

  /** One aggregate over the claims index's `status` prefix: the queued and the running rows only. */
  countByStatus(): Promise<ChildExecutionQueueCounts> {
    const { Queued, Running } = ExecutionRecordStatus;
    const row = this.connection.database
      .prepare(
        `SELECT COALESCE(SUM(status = ?), 0) AS queued, COALESCE(SUM(status = ?), 0) AS running,
                MIN(CASE WHEN status = ? THEN queued_at END) AS oldest
         FROM child_execution_queue WHERE status IN (?, ?)`,
      )
      .get(Queued, Running, Queued, Queued, Running);
    const { queued, running, oldest } = DepthRow.parse(row);
    return Promise.resolve({ queued, running, oldestQueuedAt: dateOf(oldest) });
  }
}

sqliteImplementation(SqliteChildExecutionQueueRepository);
