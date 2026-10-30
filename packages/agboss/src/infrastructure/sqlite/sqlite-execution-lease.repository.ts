import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Milliseconds } from "../../units/index.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { Clock } from "../clock.js";
import {
  ExecutionLeaseRepository,
  takenOverFromOf,
  type ExecutionLease,
} from "../execution-lease.repository.js";
import {
  ExecutionLeaseEventRepository,
  type ExecutionLeaseEventRecord,
} from "../execution-lease-event.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/** The leases' table — the fenced-effect store reads it in its own transaction (#500). */
export const EXECUTION_LEASES_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_leases (
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, root_execution_id));`;

const LeaseRow = z.object({
  holder_instance_id: z.string(),
  lease_epoch: z.number(),
  expires_at: z.number(),
  released: z.number(),
});

/**
 * `ExecutionLeaseRepository` on the application's SQLite file (#265, S32): one row per tree with
 * its latest lease (a released one kept for its epoch). `acquire` reads and writes in one
 * `BEGIN IMMEDIATE` transaction, so of two instances on one file exactly one takes a free lease;
 * `renew` and `release` are one statement each, matching the holder and the epoch. Times are the
 * framework clock's milliseconds. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class SqliteExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const now = this.clock.now().getTime();
    const { database } = this.connection;
    const taken = this.connection.transaction((): ExecutionLease | undefined => {
      const row = database
        .prepare("SELECT * FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?")
        .get(tenantId, rootExecutionId);
      const stored = row === undefined ? undefined : LeaseRow.parse(row);
      if (stored?.released === 0 && stored.expires_at > now) return undefined;
      const next: ExecutionLease = {
        tenantId,
        rootExecutionId,
        holderInstanceId: this.applicationContext.instanceId,
        leaseEpoch: (stored?.lease_epoch ?? 0) + 1,
        expiresAt: new Date(now + lease),
        ...takenOverFromOf(
          stored === undefined
            ? undefined
            : { holderInstanceId: stored.holder_instance_id, leaseEpoch: stored.lease_epoch },
          stored?.released === 0,
        ),
      };
      database
        .prepare("INSERT OR REPLACE INTO execution_leases VALUES (?, ?, ?, ?, ?, 0)")
        .run(
          tenantId,
          rootExecutionId,
          this.applicationContext.instanceId,
          next.leaseEpoch,
          now + lease,
        );
      return next;
    });
    return Promise.resolve(taken);
  }

  renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    const expiresAt = this.clock.now().getTime() + lease;
    const { changes } = this.connection.database
      .prepare(
        `UPDATE execution_leases SET expires_at = ? WHERE tenant_id = ? AND root_execution_id = ?
         AND holder_instance_id = ? AND lease_epoch = ? AND released = 0`,
      )
      .run(
        expiresAt,
        executionLease.tenantId,
        executionLease.rootExecutionId,
        executionLease.holderInstanceId,
        executionLease.leaseEpoch,
      );
    return Promise.resolve(Number(changes) === 1);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    this.connection.database
      .prepare(
        `UPDATE execution_leases SET released = 1 WHERE tenant_id = ? AND root_execution_id = ?
         AND holder_instance_id = ? AND lease_epoch = ?`,
      )
      .run(
        executionLease.tenantId,
        executionLease.rootExecutionId,
        executionLease.holderInstanceId,
        executionLease.leaseEpoch,
      );
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteExecutionLeaseRepository);

const EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_lease_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS execution_lease_events_tree
  ON execution_lease_events (tenant_id, root_execution_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS execution_lease_events_occurred ON execution_lease_events (occurred_at);`;

const EventRow = z.object({ record: z.string() });

/** A row's record (written by `save`: the record as JSON). */
const recordOf = (row: unknown): ExecutionLeaseEventRecord =>
  // the column holds exactly what `save` wrote
  JSON.parse(EventRow.parse(row).record) as ExecutionLeaseEventRecord;

/**
 * `ExecutionLeaseEventRepository` on the application's SQLite file (#501): one row per event, its
 * record as JSON beside the columns it is found by, ordered by the time it happened and then by the
 * order it was saved. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteExecutionLeaseEventRepository extends ExecutionLeaseEventRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.ensureSchema("execution_lease_events", EVENTS_SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  save(record: ExecutionLeaseEventRecord): Promise<void> {
    this.connection.database
      .prepare(
        `INSERT INTO execution_lease_events (tenant_id, root_execution_id, occurred_at, record)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        record.tenantId,
        record.rootExecutionId,
        Date.parse(record.occurredAt),
        JSON.stringify(record),
      );
    return Promise.resolve();
  }

  findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionLeaseEventRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT record FROM execution_lease_events WHERE tenant_id = ? AND root_execution_id = ?
         ORDER BY occurred_at, id`,
      )
      .all(tenantId, rootExecutionId);
    return Promise.resolve(rows.map(recordOf));
  }

  deleteByOccurredAtBefore(cutoff: Date): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM execution_lease_events WHERE occurred_at < ?")
      .run(cutoff.getTime());
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteExecutionLeaseEventRepository);
