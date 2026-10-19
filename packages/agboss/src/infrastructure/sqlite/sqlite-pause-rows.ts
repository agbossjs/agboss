import type { DatabaseSync } from "node:sqlite";
import {
  cancelledPause,
  decidedPause,
  PauseStatus,
  resolvedPause,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "../pause-record.js";
import { storedOf, toPauseRecord } from "./sqlite-pause-json.js";

/**
 * The pauses of `SqlitePausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tenant; every change of a pending pause is one conditional `UPDATE … WHERE status =
 * 'pending'`, so of two connections exactly one changes it.
 */

export const PAUSES_SCHEMA = `CREATE TABLE IF NOT EXISTS pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, step_key));
CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

/**
 * The migration of a file written before the pause answer records (#267 S107): the answer column
 * was named `resolution`; how and when a pause was resolved get columns of their own.
 */
export const PAUSE_ANSWERS_MIGRATION = `ALTER TABLE pauses RENAME COLUMN resolution TO answer;
ALTER TABLE pauses ADD COLUMN resolution TEXT;
ALTER TABLE pauses ADD COLUMN resolved_at TEXT;
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

/** The statements of the pauses, on one connection's database. */
export class SqlitePauseRows {
  constructor(private readonly database: DatabaseSync) {}

  findByStepKey(tenantId: string, stepKey: string): PauseRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM pauses WHERE tenant_id = ? AND step_key = ?")
      .get(tenantId, stepKey);
    return row === undefined ? undefined : toPauseRecord(row);
  }

  insert(pause: PauseRecord): void {
    this.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        pause.tenantId,
        pause.pauseId,
        pause.stepKey,
        pause.rootExecutionId,
        pause.status,
        pause.isSent ? 1 : 0,
        storedOf(pause),
      );
  }

  findById(tenantId: string, pauseId: string): PauseRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM pauses WHERE tenant_id = ? AND pause_id = ?")
      .get(tenantId, pauseId);
    return row === undefined ? undefined : toPauseRecord(row);
  }

  findAllByRoot(tenantId: string, rootExecutionId: string): readonly PauseRecord[] {
    return this.database
      .prepare("SELECT * FROM pauses WHERE tenant_id = ? AND root_execution_id = ? ORDER BY rowid")
      .all(tenantId, rootExecutionId)
      .map(toPauseRecord);
  }

  /** `true` when the pending pause was changed (`is_sent`, or its status). */
  markSent(tenantId: string, pauseId: string): boolean {
    const changed = this.database
      .prepare(
        "UPDATE pauses SET is_sent = 1 WHERE tenant_id = ? AND pause_id = ? AND status = 'pending'",
      )
      .run(tenantId, pauseId);
    return changed.changes > 0;
  }

  /** The pending pause closed as `closed` makes it (call inside a transaction); `undefined` when not pending. */
  close(
    tenantId: string,
    pauseId: string,
    closed: (pending: PauseRecord) => PauseRecord,
  ): PauseRecord | undefined {
    const pending = this.findById(tenantId, pauseId);
    if (pending?.status !== PauseStatus.Pending) return undefined;
    const changed = closed(pending);
    this.database
      .prepare(
        "UPDATE pauses SET status = ?, answer = ?, resolution = ?, resolved_at = ? WHERE tenant_id = ? AND pause_id = ? AND status = 'pending'",
      )
      .run(
        changed.status,
        changed.answer === undefined ? null : JSON.stringify(changed.answer),
        changed.resolution ?? null,
        changed.resolvedAt ?? null,
        tenantId,
        pauseId,
      );
    return changed;
  }

  resolve(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): PauseRecord | undefined {
    return this.close(tenantId, pauseId, (pending) => resolvedPause(pending, answer, at));
  }

  decide(tenantId: string, pauseId: string, answer: PauseAnswer, at: Date): boolean {
    return (
      this.close(tenantId, pauseId, (pending) => decidedPause(pending, answer, at)) !== undefined
    );
  }

  cancel(tenantId: string, pauseId: string, resolution: PauseCancellation, at: Date): boolean {
    const closed = this.close(tenantId, pauseId, (pending) =>
      cancelledPause(pending, resolution, at),
    );
    return closed !== undefined;
  }

  markTaken(tenantId: string, pauseId: string): void {
    this.database
      .prepare(
        "UPDATE pauses SET status = ? WHERE tenant_id = ? AND pause_id = ? AND status = 'resolved'",
      )
      .run(PauseStatus.Taken, tenantId, pauseId);
  }

  deleteResolvedBefore(cutoff: Date): void {
    this.database
      .prepare(
        "DELETE FROM pauses WHERE status IN (?, ?) AND resolved_at IS NOT NULL AND resolved_at < ?",
      )
      .run(PauseStatus.Taken, PauseStatus.Cancelled, cutoff.toISOString());
  }
}
