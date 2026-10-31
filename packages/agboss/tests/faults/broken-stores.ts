import type { DatabaseSync } from "node:sqlite";
import {
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  ApplicationContext,
  type ExecutionLease,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../../src/index.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";

/**
 * #484 — deliberately broken SQLite stores, the fault suite's negative fixtures: each breaks one
 * rule the guarantees rest on, and the scenario that targets it must fail.
 *
 * - `UnfencedSqliteFencedEffectRepository`: no fencing check on the business write — the key's
 *   token is replaced by the lease's current epoch before the store's transaction, so a zombie's
 *   write passes the lease check and the scope's mark as if it held the lease.
 * - `ReleasingSqliteExecutionLeaseRepository`: a `finish` that is a plain `release` (#520) — a
 *   finished child's lease is free for the next `acquire`.
 */

/** The lease's current epoch in the file. */
function currentEpochOf(database: DatabaseSync, key: FencedEffectKey): number {
  const row = database
    .prepare(
      "SELECT lease_epoch FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(key.tenantId, key.leaseExecutionId);
  return row === undefined ? key.token : Number(row.lease_epoch);
}

@Injectable({ deps: [SqliteConnection, Clock, FencedEffectSettings] })
export class UnfencedSqliteFencedEffectRepository extends SqliteFencedEffectRepository {
  constructor(
    private readonly sqliteConnection: SqliteConnection,
    clock: Clock,
    settings: FencedEffectSettings,
  ) {
    super(sqliteConnection, clock, settings);
  }

  protected override runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<DatabaseSync, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const token = currentEpochOf(this.sqliteConnection.database, key);
    return super.runInTransaction({ ...key, token }, work);
  }
}

@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class ReleasingSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  override finish(executionLease: ExecutionLease): Promise<void> {
    return this.release(executionLease);
  }
}
