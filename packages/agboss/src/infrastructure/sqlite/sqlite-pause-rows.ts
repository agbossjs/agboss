import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  PauseStatus,
  resolvedPause,
  type PauseRecord,
  type PauseResolution,
} from "../pause-record.js";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";

/**
 * The pauses of `SqlitePausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tenant; every change of a pending pause is one conditional `UPDATE … WHERE status =
 * 'pending'`, so of two connections exactly one changes it.
 */

export const PAUSES_SCHEMA = `CREATE TABLE IF NOT EXISTS pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, resolution TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, step_key));
CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);`;

/** What a pause row keeps as JSON: everything but its id, status, flag and resolution. */
const StoredPause = z.object({
  threadId: z.string(),
  executionId: z.string(),
  workflow: z.string(),
  nodeId: z.string(),
  visitNumber: z.number(),
  itemIndex: z.number().optional(),
  agent: z.string(),
  channel: z.string(),
  answeredBy: z.enum(PauseAnswerer),
  ask: z.object({
    callId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }),
});

const PauseRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  step_key: z.string(),
  root_execution_id: z.string(),
  status: z.enum(PauseStatus),
  is_sent: z.number(),
  pause: z.string(),
  resolution: z.string().nullable(),
});

const StoredResolution = z.object({ decision: z.unknown(), answerer: z.string().optional() });

function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  const { itemIndex, ...stored } = StoredPause.parse(JSON.parse(r.pause));
  const pause: PauseRecord = {
    ...stored,
    itemIndex,
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    stepKey: r.step_key,
    rootExecutionId: r.root_execution_id,
    status: r.status,
    isSent: r.is_sent === 1,
  };
  if (r.resolution === null) return pause;
  const { decision, answerer } = StoredResolution.parse(JSON.parse(r.resolution));
  return { ...pause, resolution: { decision, answerer } };
}

const storedOf = (pause: PauseRecord): string =>
  JSON.stringify({
    threadId: pause.threadId,
    executionId: pause.executionId,
    workflow: pause.workflow,
    nodeId: pause.nodeId,
    visitNumber: pause.visitNumber,
    itemIndex: pause.itemIndex,
    agent: pause.agent,
    channel: pause.channel,
    answeredBy: pause.answeredBy,
    ask: pause.ask,
  });

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
      .prepare("INSERT INTO pauses VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
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
      .prepare("SELECT * FROM pauses WHERE tenant_id = ? AND root_execution_id = ?")
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

  resolve(tenantId: string, pauseId: string, resolution: PauseResolution): PauseRecord | undefined {
    const pending = this.findById(tenantId, pauseId);
    if (pending?.status !== PauseStatus.Pending) return undefined;
    this.database
      .prepare(
        "UPDATE pauses SET status = ?, resolution = ? WHERE tenant_id = ? AND pause_id = ? AND status = 'pending'",
      )
      .run(PauseStatus.Resolved, JSON.stringify(resolution), tenantId, pauseId);
    return resolvedPause(pending, resolution);
  }

  cancel(tenantId: string, pauseId: string): boolean {
    const changed = this.database
      .prepare(
        "UPDATE pauses SET status = ? WHERE tenant_id = ? AND pause_id = ? AND status = 'pending'",
      )
      .run(PauseStatus.Cancelled, tenantId, pauseId);
    return changed.changes > 0;
  }

  markTaken(tenantId: string, pauseId: string): void {
    this.database
      .prepare(
        "UPDATE pauses SET status = ? WHERE tenant_id = ? AND pause_id = ? AND status = 'resolved'",
      )
      .run(PauseStatus.Taken, tenantId, pauseId);
  }

  delete(tenantId: string, pauseId: string): void {
    this.database
      .prepare("DELETE FROM pauses WHERE tenant_id = ? AND pause_id = ?")
      .run(tenantId, pauseId);
  }
}
