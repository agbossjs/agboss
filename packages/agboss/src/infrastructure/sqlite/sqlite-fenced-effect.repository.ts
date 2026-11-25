import { fencedRefusalOf } from "../../app/lease-lost.js";
import { trustedOf } from "./sqlite-transaction.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {} from "../../app/lease-lost.js";
import { Injectable } from "../../components/decorators.js";
import { StoreClock } from "../clock.js";
import { parsedStoredJson } from "../stored-step.js";
import {
  assertBusinessKey,
  assertEffectName,
  replayedFromOf,
  storedKeyFactsOf,
  type StoredKeyFacts,
} from "../fenced-effect-key.js";
import {
  FencedEffectRepository,
  IdempotencyRunStatus,
  type EffectKey,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
} from "../fenced-effect.repository.js";
import { checkSqliteCancel, SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { assertFingerprintDecided } from "../fenced-effect-fingerprint.js";

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
function storedRowOf(database: DatabaseSync, key: EffectKey): unknown {
  if (key.businessKey === undefined)
    return database
      .prepare(
        "SELECT token, result FROM fenced_effect_results WHERE scope_key = ? AND idempotency_key = ? AND name = ?",
      )
      .get(key.scopeKey, key.idempotencyKey, key.name);
  const read = database.prepare(
    "SELECT token, result, facts FROM fenced_effect_business_results WHERE tenant_id = ? AND name = ? AND business_key = ?",
  );
  // after a rotation of the idempotency secret: the row of the previous digest (#1317d)
  const row: unknown = read.get(key.tenantId, key.name, key.businessKey);
  const { previousBusinessKey } = key;
  return row === undefined && previousBusinessKey !== undefined
    ? read.get(key.tenantId, key.name, previousBusinessKey)
    : row;
}

/** `key`'s expiry as a column keeps it: the time in ms, `NULL` for none (`Ttl.Forever`). */
export const expiryOf = (key: Pick<EffectKey, "expiresAt">): number | null =>
  key.expiresAt?.getTime() ?? null;

/** Writes `key`'s result `text` under `token` at `now`, in the table of its kind. */
function insertRowOf(database: DatabaseSync, key: EffectKey, now: number, text: string): void {
  if (key.businessKey === undefined) {
    database
      .prepare(
        "INSERT INTO fenced_effect_results (scope_key, idempotency_key, name, token, stored_at, result, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(key.scopeKey, key.idempotencyKey, key.name, key.token, now, text, expiryOf(key));
    return;
  }
  database
    .prepare(
      "INSERT INTO fenced_effect_business_results (tenant_id, name, business_key, token, stored_at, result, facts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      key.tenantId,
      key.name,
      key.businessKey,
      key.token,
      now,
      text,
      JSON.stringify(storedKeyFactsOf(key)),
      expiryOf(key),
    );
}

/**
 * The scope's mark raised to the key's token, its expiry to the latest of every key's — `NULL`
 * (never) over any date, a later date over an earlier one, in portable SQL: SQLite has no
 * `GREATEST`, and a short ttl must never truncate the mark of a long one.
 */
const RAISE_MARK = `INSERT INTO fenced_effect_marks (scope_key, highest_token, stored_at, expires_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (scope_key) DO UPDATE SET
  highest_token = max(highest_token, excluded.highest_token), stored_at = excluded.stored_at,
  expires_at = CASE
    WHEN fenced_effect_marks.expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL
    WHEN fenced_effect_marks.expires_at >= excluded.expires_at THEN fenced_effect_marks.expires_at
    ELSE excluded.expires_at END`;

/** Raises `key`'s scope mark at `now` (inside the caller's transaction): its token, its expiry. */
export function raiseSqliteMark(database: DatabaseSync, key: EffectKey, now: number): void {
  database.prepare(RAISE_MARK).run(key.scopeKey, key.token, now, expiryOf(key));
}

/**
 * `FencedEffectRepository` on the application's SQLite file (#500): the scopes' marks and the
 * results in two tables of the file, beside `execution_leases` — the checks and the write are one
 * `BEGIN IMMEDIATE` transaction on the instance's connection, so of two instances one writes and the
 * other replays. The work is asynchronous and writes through the connection's `requireTransaction()`
 * (#1317c): the file's mutex holds the transaction open (capped at `SQLITE_HOLD_CAP`) while every
 * other operation waits behind it, lease renewals excepted. Listed in `@Application({ providers })` with
 * `SqliteExecutionLeaseRepository`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, StoreClock] })
export class SqliteFencedEffectRepository extends FencedEffectRepository {
  static override readonly store: StoreDescriptor = { backend: "sqlite" };

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Pick<StoreClock, "now">,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    // the file's one transaction span, asynchronous: other operations wait behind it (#1317c)
    return this.connection.held((handle) => this.#transaction(key, work, trustedOf(handle)));
  }

  deleteExpired(now: Date): Promise<number> {
    const due = now.getTime();
    return Promise.resolve(
      this.connection.transaction(() => {
        const { database } = this.connection;
        return ["fenced_effect_results", "fenced_effect_business_results", "fenced_effect_marks"]
          .map((table) =>
            Number(
              database
                .prepare(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`)
                .run(due).changes,
            ),
          )
          .reduce((all, removed) => all + removed, 0);
      }),
    );
  }

  async #transaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
    trusted: <TInner>(inner: () => TInner) => TInner,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const { database } = this.connection;
    // the store's own statements are trusted; the user's `execute` (below) never is
    const stored = trusted(() => {
      const now = this.clock.now().getTime();
      checkSqliteFence(database, key, now);
      raiseSqliteMark(database, key, now);
      return storedRowOf(database, key);
    });
    if (stored !== undefined) {
      const { token, result, facts } = ResultRow.parse(stored);
      // written by this store from the key's facts; checked by replayedFromOf
      const ids = { name: key.name };
      const replayedFrom = replayedFromOf(
        key,
        parsedStoredJson({ what: "fenced effect facts", text: facts, ids }) as StoredKeyFacts,
      );
      return {
        status: IdempotencyRunStatus.Replayed,
        result: parsedStoredJson({ what: "fenced effect result", text: result, ids }) as TResult,
        token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    // #909: no stored result — a new effect after a durable cancel is refused, the work not run
    trusted(() => {
      checkSqliteCancel(database, key);
    });
    const text = this.storedResultOf(key, await work());
    // the lease may have moved, or the cancel arrived, while the work ran: the transaction holds the
    // file's write lock, but the lease's time runs on — checked again before the row is written
    trusted(() => {
      const after = this.clock.now().getTime();
      checkSqliteFence(database, key, after);
      checkSqliteCancel(database, key);
      insertRowOf(database, key, after, text);
    });
    return {
      status: IdempotencyRunStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}

/**
 * The fencing checks of the SQLite stores (#500, #505), inside the caller's transaction: the key's
 * name is valid (#508), its lease is held, live (`expires_at > now`, #534) and its epoch, and no newer token wrote the scope — else
 * `ExecutionError.Fenced`, a hand-over.
 */
export function checkSqliteFence(database: DatabaseSync, key: EffectKey, now: number): void {
  assertEffectName(key.name);
  assertBusinessKey(key);
  // #825: in the transaction every store of the core runs, whatever its entry was overridden with
  assertFingerprintDecided(key);
  const { scopeKey, token } = key;
  const lease = sqliteLeaseOf(database, key);
  const isHeld = lease?.released === 0 && lease.lease_epoch === token && lease.expires_at > now;
  if (!isHeld) throw fencedRefusalOf({ scopeKey, token, observedToken: lease?.lease_epoch });
  const mark = database
    .prepare("SELECT highest_token FROM fenced_effect_marks WHERE scope_key = ?")
    .get(scopeKey);
  const highest = mark === undefined ? 0 : MarkRow.parse(mark).highest_token;
  if (token < highest) throw fencedRefusalOf({ scopeKey, token, observedToken: highest });
}

/** The lease row of `(tenantId, leaseExecutionId)` on the file, if any. */
function sqliteLeaseOf(
  database: DatabaseSync,
  lease: Pick<EffectKey, "tenantId" | "leaseExecutionId">,
): z.infer<typeof LeaseRow> | undefined {
  const row = database
    .prepare(
      "SELECT lease_epoch, expires_at, released FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(lease.tenantId, lease.leaseExecutionId);
  return row === undefined ? undefined : LeaseRow.parse(row);
}

sqliteImplementation(SqliteFencedEffectRepository, { ungated: ["runInTransaction"] });
