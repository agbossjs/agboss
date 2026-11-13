import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import type { StoreDescriptor } from "../../src/infrastructure/execution-lease.repository.js";
import type { DatabaseSync } from "node:sqlite";
import {
  LeaseCheck,
  SqliteOutboundCallRepository,
  StoreClock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  ApplicationContext,
  type ExecutionLease,
  type EffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../../src/index.js";
import { type OutboundCallIntent } from "../../src/stores/index.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import type { Milliseconds } from "../../src/units/index.js";

/**
 * #484 — deliberately broken SQLite stores, the fault suite's negative fixtures: each breaks one
 * rule the guarantees rest on, and the scenario that targets it must fail.
 *
 * - `UnfencedSqliteFencedEffectRepository`: no fencing check on the business write — the key's
 *   token is replaced by the lease's current epoch before the store's transaction, so a zombie's
 *   write passes the lease check and the scope's mark as if it held the lease.
 * - `ReleasingSqliteExecutionLeaseRepository`: a `retire` that is a plain `release` (#520) — a
 *   finished child's lease is free for the next `acquire`.
 * - `UnfencedSqliteOutboundCallRepository` (#584): no fencing check on the payment's intent — its
 *   writes go in at the lease's current epoch, so a zombie records a payment as if it held the lease.
 * - `OptedOutSqliteFencedEffectRepository` (#584): declares `LeaseCheck.WithoutDoubleChargeProtection`.
 * - `ForgedTokenSqliteFencedEffectRepository` (#840): a write at a forged token — one no lease was
 *   ever granted at — let through, so the history holds a write no grant explains.
 */

/** The lease's current epoch in the file. */
function currentEpochOf(database: DatabaseSync, key: EffectKey): number {
  const row = database
    .prepare(
      "SELECT lease_epoch FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(key.tenantId, key.leaseExecutionId);
  return row === undefined ? key.token : Number(row.lease_epoch);
}

@Injectable({ deps: [SqliteConnection, StoreClock, FencedEffectSettings] })
export class UnfencedSqliteFencedEffectRepository extends SqliteFencedEffectRepository {
  constructor(
    private readonly sqliteConnection: SqliteConnection,
    clock: StoreClock,
    settings: FencedEffectSettings,
  ) {
    super(sqliteConnection, clock, settings);
  }

  protected override runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<DatabaseSync, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const token = currentEpochOf(this.sqliteConnection.database, key);
    return super.runInTransaction(effectKeyForTesting(key, { token }), work);
  }
}

/** #840: the token a forged write names — far above any epoch a fault scenario grants. */
export const FORGED_TOKEN_OFFSET = 1_000_000;

/**
 * #840: a fenced-effect store that accepts a token no lease was granted at. Its entry forges the
 * key's token (the lease's epoch + `FORGED_TOKEN_OFFSET`) before the transaction — what the
 * history records of the write —, and its transaction lets the forged token through at the
 * lease's current epoch, as `UnfencedSqliteFencedEffectRepository` lets a stale one.
 */
@Injectable({ deps: [SqliteConnection, StoreClock, FencedEffectSettings] })
export class ForgedTokenSqliteFencedEffectRepository extends UnfencedSqliteFencedEffectRepository {
  override runOnce<TResult>(
    key: EffectKey,
    work: FencedEffectWork<DatabaseSync, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    return super.runOnce(
      effectKeyForTesting(key, { token: key.token + FORGED_TOKEN_OFFSET }),
      work,
    );
  }
}

@Injectable({ deps: [SqliteConnection, StoreClock, ApplicationContext] })
export class ReleasingSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  override retire(executionLease: ExecutionLease): Promise<void> {
    return this.release(executionLease);
  }
}

/**
 * #608: a lease store whose renewal says yes to a lease that is over — taken over, or expired: the
 * old holder keeps believing it holds the tree, so its `renewNow()` right before a send passes.
 */
@Injectable({ deps: [SqliteConnection, StoreClock, ApplicationContext] })
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

  override saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean> {
    const token = currentEpochOf(this.sqliteConnection.database, key);
    return super.saveIfAbsent(effectKeyForTesting(key, { token }), intent);
  }
}

/** #584: a fenced-effect store that declares the opt-out — atomic underneath, honest in its claim. */
@Injectable({ deps: [SqliteConnection, StoreClock, FencedEffectSettings] })
export class OptedOutSqliteFencedEffectRepository extends SqliteFencedEffectRepository {
  static override readonly store: StoreDescriptor = {
    ...SqliteFencedEffectRepository.store,
    leaseCheck: LeaseCheck.WithoutDoubleChargeProtection,
  };
}
