import { AGBossError } from "../../core/errors.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { Injectable } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { Clock } from "../clock.js";
import { FencedEffectSettings } from "../fenced-effect-settings.js";
import {
  checkedEffectName,
  replayedFromOf,
  storedKeyFactsOf,
  type StoredKeyFacts,
} from "../fenced-effect-key.js";
import {
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../fenced-effect.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import {
  EXECUTION_LEASES_SCHEMA,
  SqliteExecutionLeaseRepository,
} from "./sqlite-execution-lease.repository.js";

/** The scopes' marks and the results (#500); the marks are every fenced store's of the file. */
export const FENCED_EFFECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fenced_effect_marks (
  scope_key TEXT PRIMARY KEY, highest_token INTEGER NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fenced_effect_results (
  scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
  token INTEGER NOT NULL, stored_at INTEGER NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key, name));
CREATE TABLE IF NOT EXISTS fenced_effect_business_results (
  tenant_id TEXT NOT NULL, name TEXT NOT NULL, business_key TEXT NOT NULL,
  token INTEGER NOT NULL, stored_at INTEGER NOT NULL, result TEXT NOT NULL, facts TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name, business_key));`;

const LeaseRow = z.object({
  lease_epoch: z.number(),
  expires_at: z.number(),
  released: z.number(),
});
const MarkRow = z.object({ highest_token: z.number() });
const ResultRow = z.object({
  token: z.number(),
  result: z.string(),
  facts: z.string().default("{}"),
});

/** A stored row of `key`: in the step's table, or by its business key (#508). */
function storedRowOf(database: DatabaseSync, key: FencedEffectKey): unknown {
  if (key.businessKey === undefined)
    return database
      .prepare(
        "SELECT token, result FROM fenced_effect_results WHERE scope_key = ? AND idempotency_key = ? AND name = ?",
      )
      .get(key.scopeKey, key.idempotencyKey, key.name);
  return database
    .prepare(
      "SELECT token, result, facts FROM fenced_effect_business_results WHERE tenant_id = ? AND name = ? AND business_key = ?",
    )
    .get(key.tenantId, key.name, key.businessKey);
}

/** Writes `key`'s result `text` under `token` at `now`, in the table of its kind. */
function insertRowOf(
  database: DatabaseSync,
  key: FencedEffectKey,
  now: number,
  text: string,
): void {
  if (key.businessKey === undefined) {
    database
      .prepare("INSERT INTO fenced_effect_results VALUES (?, ?, ?, ?, ?, ?)")
      .run(key.scopeKey, key.idempotencyKey, key.name, key.token, now, text);
    return;
  }
  database
    .prepare("INSERT INTO fenced_effect_business_results VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      key.tenantId,
      key.name,
      key.businessKey,
      key.token,
      now,
      text,
      JSON.stringify(storedKeyFactsOf(key)),
    );
}

export const RAISE_MARK = `INSERT INTO fenced_effect_marks (scope_key, highest_token, stored_at) VALUES (?, ?, ?)
  ON CONFLICT (scope_key) DO UPDATE SET
  highest_token = max(highest_token, excluded.highest_token), stored_at = excluded.stored_at`;

/** Whether a work's result is a promise (or any thenable): an asynchronous work. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * `FencedEffectRepository` on the application's SQLite file (#500): the scopes' marks and the
 * results in two tables of the file, beside `execution_leases` — the checks and the write are one
 * `BEGIN IMMEDIATE` transaction on the instance's connection, so of two instances one writes and the
 * other replays. The work gets the connection's `DatabaseSync` and must be synchronous — the I/O of
 * a step goes before or after the call; a returned promise rolls back with
 * `FencedEffectAsyncWorkError`. Listed in `@Application({ providers })` with
 * `SqliteExecutionLeaseRepository`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock, FencedEffectSettings] })
export class SqliteFencedEffectRepository extends FencedEffectRepository<DatabaseSync> {
  static override readonly leaseRepository: Class | undefined = SqliteExecutionLeaseRepository;
  static override readonly backend: string | undefined = "sqlite";

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
    settings: FencedEffectSettings,
  ) {
    super(settings);
    connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
    connection.ensureSchema("fenced_effects", FENCED_EFFECTS_SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<DatabaseSync, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    return new Promise((resolve) => {
      resolve(this.connection.transaction(() => this.#transaction(key, work)));
    });
  }

  deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    const before = cutoff.getTime();
    this.connection.transaction(() => {
      const { database } = this.connection;
      database.prepare("DELETE FROM fenced_effect_results WHERE stored_at < ?").run(before);
      database
        .prepare("DELETE FROM fenced_effect_business_results WHERE stored_at < ?")
        .run(before);
      database.prepare("DELETE FROM fenced_effect_marks WHERE stored_at < ?").run(before);
    });
    return Promise.resolve();
  }

  #transaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<DatabaseSync, TResult>,
  ): FencedEffectOutcome<TResult> {
    const { database } = this.connection;
    const now = this.clock.now().getTime();
    checkSqliteFence(this.connection.database, key, now);
    database.prepare(RAISE_MARK).run(key.scopeKey, key.token, now);
    const stored = storedRowOf(database, key);
    if (stored !== undefined) {
      const { token, result, facts } = ResultRow.parse(stored);
      // written by this store from the key's facts; checked by replayedFromOf
      const replayedFrom = replayedFromOf(key, JSON.parse(facts) as StoredKeyFacts);
      return {
        status: FencedEffectStatus.Replayed,
        result: JSON.parse(result) as TResult,
        token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    const result = work(database);
    if (isThenable(result)) {
      // its rejection is the work's own: the effect already failed with why
      result.then(undefined, () => undefined);
      throw new FencedEffectAsyncWorkError(key.name);
    }
    const text = this.storedResultOf(key, result);
    insertRowOf(database, key, now, text);
    return {
      status: FencedEffectStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}

/**
 * The fencing checks of the SQLite stores (#500, #505), inside the caller's transaction: the key's
 * name is valid (#508), its lease is held, live (`expires_at > now`, #534) and its epoch, and no newer token wrote the scope — else
 * `ExecutionFencedError`, a hand-over.
 */
export function checkSqliteFence(database: DatabaseSync, key: FencedEffectKey, now: number): void {
  checkedEffectName(key.name);
  const { scopeKey, token } = key;
  const lease = sqliteLeaseOf(database, key);
  const isHeld = lease?.released === 0 && lease.lease_epoch === token && lease.expires_at > now;
  if (!isHeld)
    throw new ExecutionFencedError({ scopeKey, token, observedToken: lease?.lease_epoch });
  const mark = database
    .prepare("SELECT highest_token FROM fenced_effect_marks WHERE scope_key = ?")
    .get(scopeKey);
  const highest = mark === undefined ? 0 : MarkRow.parse(mark).highest_token;
  if (token < highest) throw new ExecutionFencedError({ scopeKey, token, observedToken: highest });
}

/** The lease row of `(tenantId, leaseExecutionId)` on the file, if any. */
function sqliteLeaseOf(
  database: DatabaseSync,
  lease: Pick<FencedEffectKey, "tenantId" | "leaseExecutionId">,
): z.infer<typeof LeaseRow> | undefined {
  const row = database
    .prepare(
      "SELECT lease_epoch, expires_at, released FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(lease.tenantId, lease.leaseExecutionId);
  return row === undefined ? undefined : LeaseRow.parse(row);
}

sqliteImplementation(SqliteFencedEffectRepository);

/**
 * A fenced effect on SQLite returned a promise (#500): its transaction is one synchronous group of
 * statements on the instance's connection, so it is rolled back — nothing written, the result not
 * stored. Do the step's I/O before the call (its input) or after it (with its result), and write
 * the rows with the given `DatabaseSync` only.
 */
export class FencedEffectAsyncWorkError extends AGBossError {
  static override readonly code: string = "fenced-effect.async-work";
  override name = "FencedEffectAsyncWorkError";
  readonly effect: string;

  constructor(effect: string) {
    super(
      `fenced effect "${effect}" returned a promise: a SQLite fenced effect runs its work synchronously in one transaction — nothing was written; do the I/O before or after the call`,
    );
    this.effect = effect;
  }
}
