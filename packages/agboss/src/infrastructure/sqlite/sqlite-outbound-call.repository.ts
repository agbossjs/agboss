import { z } from "zod";
import type { OutboundCallLeaseState } from "../execution-lease-event.repository.js";
import { Injectable } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { StoreClock, type Clock, lazyLoad } from "../clock.js";
import type { FencedEffectKey } from "../fenced-effect.repository.js";
import {
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallLease,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallRecord,
  type OutboundCallClaim,
  type OutboundCallEnding,
  type OutboundCallState,
} from "../outbound-call.repository.js";
import { pendingOutboundCallOf } from "../fenced-effect-key.js";
import { oneRowChanged, SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import {
  EXECUTION_LEASES_SCHEMA,
  SqliteExecutionLeaseRepository,
} from "./sqlite-execution-lease.repository.js";
import {
  checkSqliteFence,
  FENCED_EFFECTS_SCHEMA,
  RAISE_MARK,
} from "./sqlite-fenced-effect.repository.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound_calls (
  scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, status TEXT NOT NULL,
  ended_at INTEGER, record TEXT NOT NULL, business_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_step
  ON outbound_calls (scope_key, idempotency_key, name) WHERE business_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_business_key
  ON outbound_calls (tenant_id, name, business_key) WHERE business_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_calls_by_tree ON outbound_calls (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS outbound_calls_by_status ON outbound_calls (tenant_id, status);`;

const RecordRow = z.object({ record: z.string() });

const BY_STEP = "scope_key = ? AND idempotency_key = ? AND name = ? AND business_key IS NULL";
const BY_BUSINESS_KEY = "tenant_id = ? AND name = ? AND business_key = ?";

/** Where `key`'s row is (#508): by its step, or by its tenant, name and business key. */
const whereOf = (key: FencedEffectKey): readonly [string, readonly string[]] =>
  key.businessKey === undefined
    ? [BY_STEP, [key.scopeKey, key.idempotencyKey, key.name]]
    : [BY_BUSINESS_KEY, [key.tenantId, key.name, key.businessKey]];

/** The row as its writer read it: its status, attempt and attempt owner (#508). */
const AS_READ =
  "status = ? AND json_extract(record, '$.attempt') = ? AND json_extract(record, '$.attemptOwner') = ?";

/** A row's record, as the store wrote it. */
const recordOf = (row: unknown): OutboundCallRecord =>
  // written by this store from an OutboundCallRecord
  JSON.parse(RecordRow.parse(row).record) as OutboundCallRecord;

/**
 * `OutboundCallRepository` on the application's SQLite file (#505): one row per intent in
 * `outbound_calls`, beside `execution_leases` and the scopes' marks of the fenced effects (#500) —
 * every fenced method is one `BEGIN IMMEDIATE` transaction on the instance's connection: the key's
 * lease and the scope's mark checked, the mark raised, then the read or the write. Listed in
 * `@Application({ providers })` with `SqliteExecutionLeaseRepository`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, StoreClock] })
export class SqliteOutboundCallRepository extends OutboundCallRepository {
  static override readonly leaseRepository: Class | undefined = SqliteExecutionLeaseRepository;
  static override readonly backend: string | undefined = "sqlite";

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Pick<Clock, "now">,
  ) {
    super();
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
    connection.ensureSchema("fenced_effects", FENCED_EFFECTS_SCHEMA);
    connection.ensureSchema("outbound_calls", SCHEMA);
  }

  /** The store's time as a record keeps it (#658: when a read by key read). */
  #now(): string {
    return this.clock.now().toISOString();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, () => {
      const found = this.#found(key);
      // read now (#658), on the store's clock
      return found === undefined ? undefined : { ...structuredClone(found), readAt: this.#now() };
    });
  }

  saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      const record = pendingOutboundCallOf(key, intent, this.clock.now());
      const { changes } = this.connection.database
        .prepare("INSERT OR IGNORE INTO outbound_calls VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
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
    key: FencedEffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    // the store's changes load on first use (#658: the root import stays within its budget)
    const { claimedOf } = await import("../outbound-call-changes.js");
    const startedAt = this.clock.now();
    return this.#update(key, (found) => claimedOf(found, expected, claim, startedAt));
  }

  markCompleted(key: FencedEffectKey, owner: string, result: string): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Completed, result });
  }

  markFailed(key: FencedEffectKey, owner: string, failure: OutboundCallFailure): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Failed, failure: { ...failure } });
  }

  /** The attempt of `attemptOwner` ended as `ending`, now: `false` when a newer one owns it. */
  async #ended(
    key: FencedEffectKey,
    attemptOwner: string,
    ending: OutboundCallEnding,
  ): Promise<boolean> {
    const { endedOf } = await import("../outbound-call-changes.js");
    const endedAt = this.clock.now().toISOString();
    return this.#update(key, (found) => endedOf(found, attemptOwner, ending, endedAt));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    const rows = this.connection.database
      .prepare(
        "SELECT record FROM outbound_calls WHERE tenant_id = ? AND root_execution_id = ? ORDER BY rowid",
      )
      .all(tenantId, rootExecutionId);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByTenantIdAndStatus(
    tenantId: string,
    status: OutboundCallStatus,
  ): Promise<readonly OutboundCallRecord[]> {
    const rows = this.connection.database
      .prepare(
        "SELECT record FROM outbound_calls WHERE tenant_id = ? AND status = ? ORDER BY rowid",
      )
      .all(tenantId, status);
    return Promise.resolve(rows.map(recordOf));
  }

  async leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    const { sqliteLeaseStateOf } = await lazyLoad(import("../live-lease.js"));
    return sqliteLeaseStateOf(this.connection.database, lease, this.clock.now());
  }

  deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM outbound_calls WHERE ended_at IS NOT NULL AND ended_at < ?")
      .run(cutoff.getTime());
    return Promise.resolve();
  }

  #found(key: FencedEffectKey): OutboundCallRecord | undefined {
    const row = this.connection.database
      .prepare(`SELECT record FROM outbound_calls WHERE ${whereOf(key)[0]}`)
      .get(...whereOf(key)[1]);
    return row === undefined ? undefined : recordOf(row);
  }

  /** A fenced change of the key's intent, written under the key's token; none recorded → nothing. */
  #update(
    key: FencedEffectKey,
    change: (found: OutboundCallRecord) => OutboundCallRecord | undefined,
  ): Promise<boolean> {
    return this.#fenced(key, () => {
      const found = this.#found(key);
      if (found === undefined) return false;
      const changed = change(found);
      return changed !== undefined && this.#written(key, changed, found);
    });
  }

  /**
   * Writes `change` as the key's intent, under the key's token (inside a fenced transaction) — only
   * while the row is still `from` (its status, attempt and attempt owner repeated in the `WHERE`).
   * The reference for a port to a store with row locks: here `from` was read in this same `BEGIN
   * IMMEDIATE` transaction, so exactly one row changes — any other count is a bug, thrown (#626).
   */
  #written(key: FencedEffectKey, change: OutboundCallRecord, from: OutboundCallRecord): true {
    const record = { ...change, token: key.token, leaseExecutionId: key.leaseExecutionId };
    // a pending intent has no `endedAt`: an invalid date, whose NaN SQLite stores as NULL
    const endedAt = new Date(record.endedAt ?? Number.NaN).getTime();
    const [where, values] = whereOf(key);
    const { changes } = this.connection.database
      .prepare(
        `UPDATE outbound_calls SET status = ?, ended_at = ?, record = ? WHERE ${where} AND ${AS_READ}`,
      )
      .run(
        record.status,
        endedAt,
        JSON.stringify(record),
        ...values,
        from.status,
        from.attempt,
        from.attemptOwner,
      );
    return oneRowChanged(changes);
  }

  /** `work` after the fencing checks, the mark raised, in one transaction. */
  #fenced<TValue>(key: FencedEffectKey, work: () => TValue): Promise<TValue> {
    return new Promise((resolve) => {
      resolve(
        this.connection.transaction(() => {
          const now = this.clock.now().getTime();
          checkSqliteFence(this.connection.database, key, now);
          this.connection.database.prepare(RAISE_MARK).run(key.scopeKey, key.token, now);
          return work();
        }),
      );
    });
  }
}

sqliteImplementation(SqliteOutboundCallRepository);
