import type { DatabaseSync } from "node:sqlite";
import {
  Clock,
  LeaseCheck,
  SqliteOutboundCallRepository,
  StoreClock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  ApplicationContext,
  type ExecutionLease,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
  type OutboundCallIntent,
} from "../../src/index.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import type { Milliseconds } from "../../src/units/index.js";

/**
 * #484 — deliberately broken SQLite stores, the fault suite's negative fixtures: each breaks one
 * rule the guarantees rest on, and the scenario that targets it must fail.
 *
 * - `UnfencedSqliteFencedEffectRepository`: no fencing check on the business write — the key's
 *   token is replaced by the lease's current epoch before the store's transaction, so a zombie's
 *   write passes the lease check and the scope's mark as if it held the lease.
 * - `ReleasingSqliteExecutionLeaseRepository`: a `finish` that is a plain `release` (#520) — a
 *   finished child's lease is free for the next `acquire`.
 * - `UnfencedSqliteOutboundCallRepository` (#584): no fencing check on the payment's intent — its
 *   writes go in at the lease's current epoch, so a zombie records a payment as if it held the lease.
 * - `OptedOutSqliteFencedEffectRepository` (#584): declares `LeaseCheck.WithoutDoubleChargeProtection`.
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

/**
 * #608: a lease store whose renewal says yes to a lease that is over — taken over, or expired: the
 * old holder keeps believing it holds the tree, so its `confirmNow()` right before a send passes.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class StaleRenewingSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  override async renew(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<Milliseconds | undefined> {
    return (await super.renew(executionLease, lease)) ?? lease;
  }
}

@Injectable({ deps: [SqliteConnection, StoreClock] })
export class UnfencedSqliteOutboundCallRepository extends SqliteOutboundCallRepository {
  constructor(
    private readonly sqliteConnection: SqliteConnection,
    clock: StoreClock,
  ) {
    super(sqliteConnection, clock);
  }

  override saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    const token = currentEpochOf(this.sqliteConnection.database, key);
    return super.saveIfAbsent({ ...key, token }, intent);
  }
}

/** #584: a fenced-effect store that declares the opt-out — atomic underneath, honest in its claim. */
@Injectable({ deps: [SqliteConnection, StoreClock, FencedEffectSettings] })
export class OptedOutSqliteFencedEffectRepository extends SqliteFencedEffectRepository {
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}
