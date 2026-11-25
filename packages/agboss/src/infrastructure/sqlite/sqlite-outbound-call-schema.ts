import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { previousIdentityOf } from "../fenced-effect-key.js";
import { issuedKey } from "../issued-keys.js";
import type { EffectKey, EffectKeyFields } from "../fenced-effect.repository.js";
import type { OutboundCallRecord } from "../outbound-call-record.js";
import { parsedStoredJson } from "../stored-step.js";

/**
 * The `outbound_calls` table (#505, #825). `seq` is the row's place in the record order — an
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, so the rowid is declared: `VACUUM` or a dump and restore
 * keep it, and no number is given twice, even after the highest row is pruned. The paged listing
 * reads by it. `expires_at` (#1317) is when an ended call may be removed (`NULL` while it is
 * pending, and for `Ttl.Forever`: never).
 */
const OUTBOUND_CALLS_TABLE = `
CREATE TABLE IF NOT EXISTS outbound_calls (
  scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, status TEXT NOT NULL,
  expires_at INTEGER, record TEXT NOT NULL, business_key TEXT,
  seq INTEGER PRIMARY KEY AUTOINCREMENT);`;

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_step
  ON outbound_calls (scope_key, idempotency_key, name) WHERE business_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_business_key
  ON outbound_calls (tenant_id, name, business_key) WHERE business_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_calls_by_tree ON outbound_calls (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS outbound_calls_by_status ON outbound_calls (tenant_id, status, seq);
CREATE INDEX IF NOT EXISTS outbound_calls_expiry ON outbound_calls (expires_at);`;

export const OUTBOUND_CALLS_SCHEMA = `${OUTBOUND_CALLS_TABLE}${INDEXES}`;

/** The columns an intent is written with: `seq` is the table's to give. */
export const OUTBOUND_CALL_COLUMNS =
  "scope_key, idempotency_key, name, tenant_id, root_execution_id, status, expires_at, record, business_key";

const BY_STEP = "scope_key = ? AND idempotency_key = ? AND name = ? AND business_key IS NULL";
const BY_BUSINESS_KEY = "tenant_id = ? AND name = ? AND business_key = ?";

/** Where `key`'s row is (#508): by its step, or by its tenant, name and business key. */
export const whereOf = (key: EffectKey): readonly [string, readonly string[]] =>
  key.businessKey === undefined
    ? [BY_STEP, [key.scopeKey, key.idempotencyKey, key.name]]
    : [BY_BUSINESS_KEY, [key.tenantId, key.name, key.businessKey]];

/** The row as its writer read it: its status, attempt and attempt owner (#508). */
export const AS_READ =
  "status = ? AND json_extract(record, '$.attempt') = ? AND json_extract(record, '$.attemptOwner') = ?";

const RecordRow = z.object({ record: z.string() });

/** A row's record, as the store wrote it. */
export const recordOf = (row: unknown): OutboundCallRecord =>
  // written by this store from an OutboundCallRecord
  parsedStoredJson({
    what: "outbound call record",
    text: RecordRow.parse(row).record,
  }) as OutboundCallRecord;

/**
 * The intent of `key`: under its own business key — or, after a rotation of the idempotency secret
 * (#1317d), under the digest the previous secret made of it.
 */
export function recordFound(
  database: DatabaseSync,
  key: EffectKey,
): OutboundCallRecord | undefined {
  for (const at of [key, previousIdentityOf(key)]) {
    if (at === undefined) continue;
    const [where, values] = whereOf(at);
    const row = database.prepare(`SELECT record FROM outbound_calls WHERE ${where}`).get(...values);
    if (row !== undefined) return recordOf(row);
  }
  return undefined;
}

/** `key` as the row `from` is stored under: its business key is the one the row was written with. */
export const storedUnder = (key: EffectKey, from: OutboundCallRecord): EffectKey =>
  from.businessKey === undefined || from.businessKey === key.businessKey
    ? key
    : (issuedKey({ ...(key as EffectKeyFields), businessKey: from.businessKey }) as EffectKey);
