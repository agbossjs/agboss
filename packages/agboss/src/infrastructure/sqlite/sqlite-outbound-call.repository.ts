import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { Clock } from "../clock.js";
import type { FencedEffectKey } from "../fenced-effect.repository.js";
import {
  endedOf,
  isInState,
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallRecord,
  type OutboundCallClaim,
  type OutboundCallEnding,
  type OutboundCallState,
  withoutEnd,
} from "../outbound-call.repository.js";
import { businessFactsOf } from "../fenced-effect-key.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import {
  EXECUTION_LEASES_SCHEMA,
  SqliteExecutionLeaseRepository,
} from "./sqlite-execution-lease.repository.js";
import {
  checkSqliteFence,
  FENCED_EFFECTS_SCHEMA,
  isSqliteLeaseOpen,
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
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqliteOutboundCallRepository extends OutboundCallRepository {
  static override readonly leaseRepository: Class | undefined = SqliteExecutionLeaseRepository;

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
    connection.ensureSchema("fenced_effects", FENCED_EFFECTS_SCHEMA);
    connection.ensureSchema("outbound_calls", SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, () => this.#found(key));
  }

  saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    return this.#fenced(key, () => {
      const record: OutboundCallRecord = {
        ...intent,
        tenantId: key.tenantId,
        name: key.name,
        status: OutboundCallStatus.Pending,
        token: key.token,
        leaseExecutionId: key.leaseExecutionId,
        ...businessFactsOf(key),
        recordedAt: this.clock.now().toISOString(),
      };
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

  markPending(
    key: FencedEffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    return this.#update(key, (found) =>
      isInState(found, expected)
        ? { ...withoutEnd(found), status: OutboundCallStatus.Pending, ...claim }
        : undefined,
    );
  }

  markCompleted(key: FencedEffectKey, owner: string, result: string): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Completed, result });
  }

  markFailed(key: FencedEffectKey, owner: string, failure: OutboundCallFailure): Promise<boolean> {
    return this.#ended(key, owner, { status: OutboundCallStatus.Failed, failure: { ...failure } });
  }

  /** The attempt of `attemptOwner` ended as `ending`, now: `false` when a newer one owns it. */
  #ended(key: FencedEffectKey, attemptOwner: string, ending: OutboundCallEnding): Promise<boolean> {
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

  isLeaseOpen(tenantId: string, leaseExecutionId: string, token: number): Promise<boolean> {
    const lease = { tenantId, leaseExecutionId, token };
    return Promise.resolve(
      isSqliteLeaseOpen(this.connection.database, lease),
    );
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
      const changed = found === undefined ? undefined : change(found);
      if (changed !== undefined) this.#write(key, changed);
      return changed !== undefined;
    });
  }

  /** Writes `change` as the key's intent, under the key's token (inside a fenced transaction). */
  #write(key: FencedEffectKey, change: OutboundCallRecord): void {
    const record = { ...change, token: key.token, leaseExecutionId: key.leaseExecutionId };
    const endedAt = record.endedAt === undefined ? null : Date.parse(record.endedAt);
    const [where, values] = whereOf(key);
    this.connection.database
      .prepare(`UPDATE outbound_calls SET status = ?, ended_at = ?, record = ? WHERE ${where}`)
      .run(record.status, endedAt, JSON.stringify(record), ...values);
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
