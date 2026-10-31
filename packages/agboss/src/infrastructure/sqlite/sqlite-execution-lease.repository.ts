import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Milliseconds } from "../../units/index.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { StoreClock } from "../clock.js";
import {
  ExecutionLeaseRepository,
  takenOverFromOf,
  type ExecutionIdentity,
  type ExecutionLease,
} from "../execution-lease.repository.js";
import {
  ExecutionLeaseEventRepository,
  type ExecutionLeaseEventRecord,
} from "../execution-lease-event.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { ensureExecutionIdsSchema, savedExecutionId } from "./sqlite-execution-ids.js";

/** The leases' table — the fenced-effect store reads it in its own transaction (#500). */
export const EXECUTION_LEASES_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_leases (
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
  yielded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, root_execution_id));`;

/** The column of a yielded lease (#516), added to a file an older version wrote. */
const YIELDED_COLUMN = ["execution_leases", "yielded", "INTEGER NOT NULL DEFAULT 0"] as const;

/**
 * `released`: 0 held (or expired), 1 released by its holder, 2 closed as expired by an outbound
 * call's check (#508, `SUPERSEDED`) — not held either way, but a take of a superseded one is a
 * takeover from its holder —, 3 finished by its holder (#520, `FINISHED`): never acquired again.
 */
const RELEASED = 1;
const FINISHED = 3;

/** The key, holder and epoch of a lease, as `release` and `finish` match it. */
const SAME_LEASE = `tenant_id = ? AND root_execution_id = ? AND holder_instance_id = ?
  AND lease_epoch = ?`;

/**
 * The holder's own lease still live, as `renew`, `yield` and `reclaim` match it: not released and
 * `expires_at > now` (#534 — at its expiry a lease is over for its holder too).
 */
const HELD_BY = `${SAME_LEASE} AND released = 0 AND expires_at > ?`;

/** The key, holder and epoch of `lease`, in `SAME_LEASE`'s order. */
const sameLease = ({ tenantId, rootExecutionId, holderInstanceId, leaseEpoch }: ExecutionLease) =>
  [tenantId, rootExecutionId, holderInstanceId, leaseEpoch] as const;

/** `sameLease`, then the time (ms) it must still be live at: `HELD_BY`'s parameters. */
const heldBy = (lease: ExecutionLease, now: number) => [...sameLease(lease), now] as const;

const LeaseRow = z.object({
  holder_instance_id: z.string(),
  lease_epoch: z.number(),
  expires_at: z.number(),
  released: z.number(),
});

/** Whether `acquire` refuses a stored lease: still held, or finished (#520). */
const isRefused = ({ released, expires_at }: z.infer<typeof LeaseRow>, now: number): boolean =>
  released === FINISHED || (released === 0 && expires_at > now); // live: expires_at > now (#534)

/**
 * `ExecutionLeaseRepository` on the application's SQLite file (#265, S32): one row per tree with
 * its latest lease (a released one kept for its epoch). `acquire` reads and writes in one
 * `BEGIN IMMEDIATE` transaction, so of two instances on one file exactly one takes a free lease;
 * `renew`, `release`, `yield` and `reclaim` (#516: `yielded`, the next epoch) are one statement each,
 * matching the holder and the epoch — `renew`, `yield` and `reclaim` a lease still live too
 * (`expires_at > now`, #534); `finish` (#520) is a release no `acquire` passes (`released =
 * 3`); `saveExecutionIdIfAbsent` (#591) one insert into `execution_ids`. Times are the host's — the application's clock, read through `StoreClock` (#533: a test's
 * clock in tests) — in milliseconds; every take and renewal answers the time left. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, StoreClock, ApplicationContext] })
export class SqliteExecutionLeaseRepository extends ExecutionLeaseRepository {
  static override readonly backend: string | undefined = "sqlite";

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Pick<StoreClock, "now">,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
    connection.addColumn(...YIELDED_COLUMN);
    ensureExecutionIdsSchema(connection);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveExecutionIdIfAbsent(identity: ExecutionIdentity): Promise<boolean> {
    return Promise.resolve(savedExecutionId(this.connection, identity));
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
      if (stored !== undefined && isRefused(stored, now)) return undefined;
      const next: ExecutionLease = {
        tenantId,
        rootExecutionId,
        holderInstanceId: this.applicationContext.instanceId,
        leaseEpoch: (stored?.lease_epoch ?? 0) + 1,
        expiresAt: new Date(now + lease),
        remaining: lease,
        ...takenOverFromOf(
          stored === undefined
            ? undefined
            : { holderInstanceId: stored.holder_instance_id, leaseEpoch: stored.lease_epoch },
          // not released by its holder: expired (0), or closed as expired by a call's check (2, #508)
          stored !== undefined && stored.released !== RELEASED,
        ),
      };
      database
        .prepare(
          `INSERT OR REPLACE INTO execution_leases (tenant_id, root_execution_id,
           holder_instance_id, lease_epoch, expires_at, released, yielded)
           VALUES (?, ?, ?, ?, ?, 0, 0)`,
        )
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

  renew(held: ExecutionLease, lease: Milliseconds): Promise<Milliseconds | undefined> {
    const now = this.clock.now().getTime();
    const { changes } = this.connection.database
      .prepare(`UPDATE execution_leases SET expires_at = ? WHERE ${HELD_BY}`)
      .run(now + lease, ...heldBy(held, now));
    return Promise.resolve(Number(changes) === 1 ? lease : undefined);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    return this.#released(executionLease, RELEASED);
  }

  finish(executionLease: ExecutionLease): Promise<void> {
    return this.#released(executionLease, FINISHED);
  }

  /** The holder's own lease released as `released` (a finished one stays finished, #520). */
  #released(executionLease: ExecutionLease, released: number): Promise<void> {
    this.connection.database
      .prepare(
        `UPDATE execution_leases SET released = CASE released WHEN 3 THEN 3 ELSE ? END,
         yielded = 0 WHERE ${SAME_LEASE}`,
      )
      .run(released, ...sameLease(executionLease));
    return Promise.resolve();
  }

  yield(executionLease: ExecutionLease): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(`UPDATE execution_leases SET yielded = 1 WHERE ${HELD_BY}`)
      .run(...heldBy(executionLease, this.clock.now().getTime()));
    return Promise.resolve(Number(changes) === 1);
  }

  reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const now = this.clock.now().getTime();
    const expiresAt = now + lease;
    const { changes } = this.connection.database
      .prepare(
        `UPDATE execution_leases SET lease_epoch = lease_epoch + 1, expires_at = ?, yielded = 0
         WHERE ${HELD_BY}`,
      )
      .run(expiresAt, ...heldBy(executionLease, now));
    if (Number(changes) !== 1) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId, leaseEpoch } = executionLease;
    const reclaimed = { tenantId, rootExecutionId, holderInstanceId, leaseEpoch: leaseEpoch + 1 };
    return Promise.resolve({ ...reclaimed, expiresAt: new Date(expiresAt), remaining: lease });
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
