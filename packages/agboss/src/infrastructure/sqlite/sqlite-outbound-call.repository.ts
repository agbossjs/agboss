import type { StoreDescriptor } from "../execution-lease.repository.js";
import type { OutboundCallLeaseState } from "../execution-audit-log.repository.js";
import type { Page } from "../../app/page.js";
import { Injectable } from "../../components/decorators.js";
import { StoreClock, lazyLoad } from "../clock.js";
import type { EffectKey } from "../fenced-effect.repository.js";
import {
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallStatusQuery,
  type OutboundCallLease,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallRecord,
  type OutboundCallClaim,
  type OutboundCallEnding,
  type OutboundCallState,
} from "../outbound-call.repository.js";
import { pendingOutboundCallOf } from "../fenced-effect-key.js";
import { sqlitePageOf } from "./sqlite-outbound-call-pages.js";
import {
  AS_READ,
  OUTBOUND_CALL_COLUMNS,
  recordFound,
  recordOf,
  storedUnder,
  whereOf,
} from "./sqlite-outbound-call-schema.js";
import {
  checkSqliteCancel,
  oneRowChanged,
  SqliteConnection,
  sqliteImplementation,
} from "./sqlite-connection.js";
import { checkSqliteFence, raiseSqliteMark } from "./sqlite-fenced-effect.repository.js";

/**
 * `OutboundCallRepository` on the application's SQLite file (#505): one row per intent in
 * `outbound_calls`, beside `execution_leases` and the scopes' marks of the fenced effects (#500) —
 * every fenced method is one `BEGIN IMMEDIATE` transaction on the instance's connection: the key's
 * lease and the scope's mark checked, the mark raised, then the read or the write. Listed in
 * `@Application({ providers })` with `SqliteExecutionLeaseRepository`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, StoreClock] })
export class SqliteOutboundCallRepository extends OutboundCallRepository {
  static override readonly store: StoreDescriptor = { backend: "sqlite" };

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Pick<StoreClock, "now">,
  ) {
    super();
  }

  /**
   * How it changes an intent (#658), loaded when the store is made, not with the root import (its
   * module budget): long loaded by the first change.
   */
  readonly #changes = lazyLoad(import("../outbound-call-changes.js"));

  /** The store's time as a record keeps it (#658: when a read by key read). */
  #now(): string {
    return this.clock.now().toISOString();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, () => {
      const found = this.#found(key);
      // read now (#658), on the store's clock
      return found === undefined ? undefined : { ...structuredClone(found), readAt: this.#now() };
    });
  }

  saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      checkSqliteCancel(this.connection.database, key); // #909: a new intent is a new send
      // recorded already — under the key, or under the digest of a secret since rotated
      if (this.#found(key) !== undefined) return false;
      const record = pendingOutboundCallOf(key, intent, this.clock.now());
      const { changes } = this.connection.database
        .prepare(
          `INSERT OR IGNORE INTO outbound_calls (${OUTBOUND_CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          key.scopeKey,
          key.idempotencyKey,
          key.name,
          key.tenantId,
          intent.rootExecutionId,
          record.status,
          JSON.stringify(record),
          key.businessKey ?? null,
        );
      return Number(changes) === 1;
    });
  }

  async markPending(
    key: EffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    // the store's changes load on first use (#658: the root import stays within its budget)
    const startedAt = this.clock.now();
    const { claimedOf } = await this.#changes;
    // #909: a new attempt is a new send, refused after the tree's cancel
    return this.#update(key, (found) => claimedOf(found, expected, claim, startedAt), true);
  }

  markCompleted(
    key: EffectKey,
    attemptOwner: string,
    result: string,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const ending = { status: OutboundCallStatus.Completed, result } as const;
    return this.#ended(key, attemptOwner, ending, expiresAt);
  }

  markFailed(
    key: EffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const ending = { status: OutboundCallStatus.Failed, failure: { ...failure } } as const;
    return this.#ended(key, attemptOwner, ending, expiresAt);
  }

  /** The attempt of `attemptOwner` ended as `ending`, now: `false` when a newer one owns it. */
  async #ended(
    key: EffectKey,
    attemptOwner: string,
    ending: OutboundCallEnding,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const endedAt = this.clock.now().toISOString();
    const { endedOf } = await this.#changes;
    return this.#update(
      key,
      (found) => endedOf(found, attemptOwner, ending, endedAt),
      false,
      expiresAt?.getTime() ?? null,
    );
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    const rows = this.connection.database
      .prepare(
        "SELECT record FROM outbound_calls WHERE tenant_id = ? AND root_execution_id = ? ORDER BY seq",
      )
      .all(tenantId, rootExecutionId);
    return Promise.resolve(rows.map(recordOf));
  }

  /**
   * A page of a tenant's calls in `status` (#825): keyset on `seq`, the row's declared rowid — kept
   * while it lives, through a `VACUUM` or a restore, and never given again. The cursor is the page's
   * last `seq`, as text.
   */
  findAllByTenantIdAndStatus(query: OutboundCallStatusQuery): Promise<Page<OutboundCallRecord>> {
    return sqlitePageOf(this.connection.database, query, recordOf);
  }

  async leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    const { sqliteLeaseStateOf } = await lazyLoad(import("../live-lease.js"));
    return sqliteLeaseStateOf(this.connection.database, lease, this.clock.now());
  }

  deleteExpired(now: Date): Promise<number> {
    const { changes } = this.connection.database
      .prepare("DELETE FROM outbound_calls WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now.getTime());
    return Promise.resolve(Number(changes));
  }

  #found(key: EffectKey): OutboundCallRecord | undefined {
    return recordFound(this.connection.database, key);
  }

  /** A fenced change of the key's intent, written under the key's token; none recorded → nothing. */
  #update(
    key: EffectKey,
    change: (found: OutboundCallRecord) => OutboundCallRecord | undefined,
    isSend = false,
    expiresAt: number | null = null,
  ): Promise<boolean> {
    return this.#fenced(key, () => {
      if (isSend) checkSqliteCancel(this.connection.database, key);
      const found = this.#found(key);
      if (found === undefined) return false;
      const changed = change(found);
      return changed !== undefined && this.#written(key, changed, found, expiresAt);
    });
  }

  /**
   * Writes `change` as the key's intent, under the key's token (inside a fenced transaction) — only
   * while the row is still `from` (its status, attempt and attempt owner repeated in the `WHERE`).
   * The reference for a port to a store with row locks: here `from` was read in this same `BEGIN
   * IMMEDIATE` transaction, so exactly one row changes — any other count is a bug, thrown (#626).
   */
  #written(
    key: EffectKey,
    change: OutboundCallRecord,
    from: OutboundCallRecord,
    expiresAt: number | null,
  ): true {
    const record = { ...change, token: key.token, leaseExecutionId: key.leaseExecutionId };
    const [where, values] = whereOf(storedUnder(key, from));
    const { changes } = this.connection.database
      .prepare(
        `UPDATE outbound_calls SET status = ?, expires_at = ?, record = ? WHERE ${where} AND ${AS_READ}`,
      )
      .run(
        record.status,
        expiresAt,
        JSON.stringify(record),
        ...values,
        from.status,
        from.attempt,
        from.attemptOwner,
      );
    return oneRowChanged(changes);
  }

  /** `work` after the fencing checks, the mark raised, in one transaction. */
  #fenced<TValue>(key: EffectKey, work: () => TValue): Promise<TValue> {
    return new Promise((resolve) => {
      resolve(
        this.connection.transaction(() => {
          const now = this.clock.now().getTime();
          checkSqliteFence(this.connection.database, key, now);
          raiseSqliteMark(this.connection.database, key, now);
          return work();
        }),
      );
    });
  }
}

sqliteImplementation(SqliteOutboundCallRepository);
