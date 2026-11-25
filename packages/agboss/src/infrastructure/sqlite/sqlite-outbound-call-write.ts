import type { DatabaseSync } from "node:sqlite";
import type { EffectKey } from "../fenced-effect.repository.js";
import type { OutboundCallRecord } from "../outbound-call-record.js";
import { oneRowChanged } from "./sqlite-connection.js";
import { AS_READ, storedUnder, whereOf } from "./sqlite-outbound-call-schema.js";

/**
 * Writes `changed` as the key's intent, under the key's token (inside a fenced transaction) — only
 * while the row is still `found` (its status, attempt and attempt owner repeated in the `WHERE`).
 * The reference for a port to a store with row locks: here `found` was read in this same `BEGIN
 * IMMEDIATE` transaction, so exactly one row changes — any other count is a bug, thrown (#626).
 */
export function writtenOver(
  database: DatabaseSync,
  key: EffectKey,
  {
    changed,
    found,
    expiresAt,
  }: {
    readonly changed: OutboundCallRecord;
    readonly found: OutboundCallRecord;
    readonly expiresAt: number | null;
  },
): true {
  const record = { ...changed, token: key.token, leaseExecutionId: key.leaseExecutionId };
  const [where, values] = whereOf(storedUnder(key, found));
  const { changes } = database
    .prepare(
      `UPDATE outbound_calls SET status = ?, expires_at = ?, record = ? WHERE ${where} AND ${AS_READ}`,
    )
    .run(
      record.status,
      expiresAt,
      JSON.stringify(record),
      ...values,
      found.status,
      found.attempt,
      found.attemptOwner,
    );
  return oneRowChanged(changes);
}
