import type { StoreDescriptor } from "../execution-lease.repository.js";
import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Milliseconds } from "../../units/index.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { StoreClock, lazyLoad } from "../clock.js";
import {
  ExecutionLeaseRepository,
  remainingOf,
  takenOverFromOf,
  type ExecutionIdentity,
  type ExecutionLease,
} from "../execution-lease.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

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
 * takeover from its holder —, 3 retired by its holder (#520, `RETIRED`): never acquired again.
 */
const RELEASED = 1;
const RETIRED = 3;

/** The key, holder and epoch of a lease, as `release` and `retire` match it. */
const SAME_LEASE = `tenant_id = ? AND root_execution_id = ? AND holder_instance_id = ?
  AND lease_epoch = ?`;

/**
 * The holder's own lease still live, as `renew`, `yield` and `reclaim` match it: not released and
 * `expires_at > now` (#534 — at its expiry a lease is over for its holder too).
 */
const HELD_BY = `${SAME_LEASE} AND released = 0 AND expires_at > ?`;

/** The key, holder and epoch of `lease`, in `SAME_LEASE`'s order. */
const sameLease = ({ tenantId, rootExecutionId, holderInstanceId, token }: ExecutionLease) =>
  [tenantId, rootExecutionId, holderInstanceId, token] as const;

/** `sameLease`, then the time (ms) it must still be live at: `HELD_BY`'s parameters. */
const heldBy = (lease: ExecutionLease, now: number) => [...sameLease(lease), now] as const;

const LeaseRow = z.object({
  holder_instance_id: z.string(),
  lease_epoch: z.number(),
  expires_at: z.number(),
  released: z.number(),
});

/** Whether `acquire` refuses a stored lease: still held, or retired (#520). */
const isRefused = ({ released, expires_at }: z.infer<typeof LeaseRow>, now: number): boolean =>
  released === RETIRED || (released === 0 && expires_at > now); // live: expires_at > now (#534)

/**
 * `ExecutionLeaseRepository` on the application's SQLite file (#265, S32): one row per tree with
 * its latest lease (a released one kept for its epoch). `acquire` reads and writes in one
 * `BEGIN IMMEDIATE` transaction, so of two instances on one file exactly one takes a free lease;
 * `renew`, `release`, `yield` and `reclaim` (#516: `yielded`, the next epoch) are one statement each,
 * matching the holder and the epoch — `renew`, `yield` and `reclaim` a lease still live too
 * (`expires_at > now`, #534); `retire` (#520) a release no `acquire` passes (`released = 3`);
 * `claimExecutionId` (#591) one insert into `execution_ids`; the token is the 0.1.0 column
 * `lease_epoch`. Times are the host's (`StoreClock`, #533; a test's clock in tests), in ms; every
 * take, renewal and yield answers the time left. Listed in `@Application({ providers })`.
 */
@Injectable({ deps: [SqliteConnection, StoreClock, ApplicationContext] })
export class SqliteExecutionLeaseRepository extends ExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "sqlite" };

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Pick<StoreClock, "now">,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
    connection.addColumn(...YIELDED_COLUMN);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  /** Loaded on first use (#591): the root import stays as it was. */
  async claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    const { savedExecutionId } = await lazyLoad(import("./sqlite-execution-ids.js"));
    return savedExecutionId(this.connection, identity);
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
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
        token: (stored?.lease_epoch ?? 0) + 1,
        expiresAt: new Date(now + duration),
        remaining: duration,
        ...takenOverFromOf(
          stored === undefined
            ? undefined
            : { holderInstanceId: stored.holder_instance_id, token: stored.lease_epoch },
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
          next.token,
          now + duration,
        );
      return next;
    });
    return Promise.resolve(taken);
  }

  renew(held: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    const now = this.clock.now().getTime();
    const { changes } = this.connection.database
      .prepare(`UPDATE execution_leases SET expires_at = ? WHERE ${HELD_BY}`)
      .run(now + duration, ...heldBy(held, now));
    return Promise.resolve(Number(changes) === 1 ? duration : undefined);
  }

  release(executionLease: ExecutionLease): Promise<void> {
    return this.#released(executionLease, RELEASED);
  }

  retire(executionLease: ExecutionLease): Promise<void> {
    return this.#released(executionLease, RETIRED);
  }

  /** The holder's own lease released as `released` (a retired one stays retired, #520). */
  #released(executionLease: ExecutionLease, released: number): Promise<void> {
    this.connection.database
      .prepare(
        `UPDATE execution_leases SET released = CASE released WHEN 3 THEN 3 ELSE ? END,
         yielded = 0 WHERE ${SAME_LEASE}`,
      )
      .run(released, ...sameLease(executionLease));
    return Promise.resolve();
  }

  yield(executionLease: ExecutionLease): Promise<Milliseconds | undefined> {
    const now = this.clock.now().getTime();
    const yielded = this.connection.database
      .prepare(`UPDATE execution_leases SET yielded = 1 WHERE ${HELD_BY} RETURNING expires_at`)
      .get(...heldBy(executionLease, now));
    if (yielded === undefined) return Promise.resolve(undefined);
    const { expires_at } = LeaseRow.pick({ expires_at: true }).parse(yielded);
    return Promise.resolve(remainingOf(new Date(expires_at), new Date(now)));
  }

  reclaim(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const now = this.clock.now().getTime();
    const expiresAt = now + duration;
    const { changes } = this.connection.database
      .prepare(
        `UPDATE execution_leases SET lease_epoch = lease_epoch + 1, expires_at = ?, yielded = 0
         WHERE ${HELD_BY}`,
      )
      .run(expiresAt, ...heldBy(executionLease, now));
    if (Number(changes) !== 1) return Promise.resolve(undefined);
    const { tenantId, rootExecutionId, holderInstanceId, token } = executionLease;
    const reclaimed = { tenantId, rootExecutionId, holderInstanceId, token: token + 1 };
    return Promise.resolve({ ...reclaimed, expiresAt: new Date(expiresAt), remaining: duration });
  }
}

sqliteImplementation(SqliteExecutionLeaseRepository);

export { SqliteExecutionAuditLogRepository } from "./sqlite-execution-audit-log.repository.js";
