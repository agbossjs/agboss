import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import * as step from "../stored-step.js";
import { ExpiryProblem, PauseExpiryBound } from "../pause-record.js";
import { PauseKind, PauseResolution, PauseStatus, type PauseRecord } from "../pause-record.js";

/**
 * The pauses of `SqlitePausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tree (#663); every change of a pending pause is one conditional `UPDATE … WHERE status =
 * 'pending'`, so of two connections exactly one changes it.
 */

/** #663: unique per step key of a tree — a step key names no tree, so another tree's never matches. */
export const PAUSES_TABLE = `CREATE TABLE IF NOT EXISTS pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
  expires_at TEXT, remind_at TEXT, channel TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`;

/** #910: the deadline and reminder scans, and a tenant's pages (`rowid` is the insertion sequence). */
export const PAUSES_INDEXES = `CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_expiry ON pauses (status, expires_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_remind ON pauses (status, remind_at);
CREATE INDEX IF NOT EXISTS pauses_by_tenant ON pauses (tenant_id, status, channel);`;

export const PAUSES_SCHEMA = `${PAUSES_TABLE}\n${PAUSES_INDEXES}`;

/**
 * A pause row of `SqlitePausedExecutionRepository` read and written (#267 S35, S107): its columns
 * and the JSON it keeps, each validated on the way out; a row stored by an earlier version reads
 * with defaults (no copy number: the first copy; no resolution column: its status says).
 */

/** What a pause row keeps as JSON: everything but its id, status, flag, resolution and times. */
const StoredPause = z.object({
  threadId: z.string(),
  executionId: z.string(),
  workflow: z.string(),
  nodeId: z.string(),
  visitNumber: z.number(),
  itemIndex: z.number().optional(),
  // a pause stored before #267 S107 kept neither: the first copy, asked at an unknown time
  copyNumber: z.number().default(1),
  askedAt: z.string().default(""),
  kind: z.enum(PauseKind),
  step: z.string(),
  ...step.StoredLoopProgress,
  channel: z.string(),
  // a pause stored before #337 has none: its own step's key is its only branch key
  branchKeys: z.array(z.string()).optional(),
  // 0.1.0's JSON has `answeredBy` (who may answer), the new `answerer` (#934)
  answerer: z.enum(PauseAnswerer).optional(),
  answeredBy: z.enum(PauseAnswerer).optional(),
  ask: z.record(z.string(), z.unknown()), // a tool call, or a role's ask (#659, #712): `kind` says
  // #910: the deadline's bound and where it may not pass, why an expiry fell back to fail
  expiryBound: z.enum(PauseExpiryBound).optional(),
  boundAt: z.string().optional(),
  expiryProblem: z.enum(ExpiryProblem).optional(),
});

const PauseRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  step_key: z.string(),
  root_execution_id: z.string(),
  status: z.enum(PauseStatus),
  is_sent: z.number(),
  pause: z.string(),
  answer: z.string().nullable(),
  resolution: z.enum(PauseResolution).nullable(),
  resolved_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  remind_at: z.string().nullable(),
});

/** How a row was resolved: its column, else (a row stored before #267 S107) its status says. */
function resolutionOf(r: z.infer<typeof PauseRow>): { resolution?: PauseResolution } {
  if (r.resolution !== null) return { resolution: r.resolution };
  if (r.status === PauseStatus.Cancelled) return { resolution: PauseResolution.Cancelled };
  return r.answer === null ? {} : { resolution: PauseResolution.Replied };
}

/** A row as the record it keeps. */
export function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  const parsed = StoredPause.safeParse(JSON.parse(r.pause));
  if (!parsed.success)
    throw new Error(`pause ${r.pause_id} (${r.tenant_id}) unreadable: ${step.paths(parsed.error)}`);
  const { itemIndex, component, branchKeys, ask, ...stored } = parsed.data;
  const pause = {
    ...stored,
    ask: step.askOfStored(ask, stored.kind === PauseKind.Question),
    ...(component === undefined ? {} : { component: step.componentOfStored(component) }),
    ...(branchKeys === undefined ? {} : { branchKeys }),
    itemIndex,
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    stepKey: r.step_key,
    rootExecutionId: r.root_execution_id,
    status: r.status,
    isSent: r.is_sent === 1,
  };
  return step.pauseRecordOfStored({
    ...pause,
    ...(r.answer === null ? {} : { answer: step.answerOf(r.answer) }),
    ...resolutionOf(r),
    ...(r.resolved_at === null ? {} : { resolvedAt: r.resolved_at }),
    ...(r.expires_at === null ? {} : { expiresAt: r.expires_at }),
    ...(r.remind_at === null ? {} : { remindAt: r.remind_at }),
  });
}

/** What a row keeps of a record as JSON. */
const storedOf = (pause: PauseRecord): string =>
  JSON.stringify({
    threadId: pause.threadId,
    executionId: pause.executionId,
    workflow: pause.workflow,
    nodeId: pause.nodeId,
    visitNumber: pause.visitNumber,
    itemIndex: pause.itemIndex,
    copyNumber: pause.copyNumber,
    askedAt: pause.askedAt,
    kind: pause.kind,
    step: pause.step,
    component: pause.component,
    toolLoopIteration: pause.toolLoopIteration,
    validationAttempts: pause.validationAttempts,
    channel: pause.channel,
    branchKeys: pause.branchKeys,
    answerer: pause.answerer,
    ask: pause.ask,
    expiryBound: pause.expiryBound,
    boundAt: pause.boundAt,
    expiryProblem: pause.expiryProblem,
  });

/** The statements of the pauses, on one connection's database. */
export class SqlitePauseRows {
  constructor(private readonly database: DatabaseSync) {}

  /** The pause of the step key in the tenant's tree (#663: never another tree's). */
  findByStepKey({ tenantId, rootExecutionId, stepKey }: PauseRecord): PauseRecord | undefined {
    return this.findByTree(tenantId, rootExecutionId, stepKey);
  }

  /** The pause of the step key in the tenant's tree: the unique key, one indexed read. */
  findByTree(tenantId: string, rootExecutionId: string, stepKey: string): PauseRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM pauses WHERE tenant_id = ? AND root_execution_id = ? AND step_key = ?",
      )
      .get(tenantId, rootExecutionId, stepKey);
    return row === undefined ? undefined : toPauseRecord(row);
  }

  insert(pause: PauseRecord): void {
    this.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, expires_at, remind_at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        pause.tenantId,
        pause.pauseId,
        pause.stepKey,
        pause.rootExecutionId,
        pause.status,
        pause.isSent ? 1 : 0,
        storedOf(pause),
        pause.expiresAt ?? null,
        pause.remindAt ?? null,
        pause.channel,
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

  /**
   * Writes `changed` over the pause that is `was` (call inside a transaction: the row was read
   * first): its status, flag, answer, resolution, times and JSON — one conditional `UPDATE`, so a
   * row another writer changed is never overwritten. `false` when it is no longer `was`.
   */
  write(changed: PauseRecord, was: PauseStatus): boolean {
    const { changes } = this.database
      .prepare(
        "UPDATE pauses SET status = ?, is_sent = ?, pause = ?, answer = ?, resolution = ?, resolved_at = ?, expires_at = ?, remind_at = ? WHERE tenant_id = ? AND pause_id = ? AND status = ?",
      )
      .run(
        changed.status,
        changed.isSent ? 1 : 0,
        storedOf(changed),
        changed.answer === undefined ? null : JSON.stringify(changed.answer),
        changed.resolution ?? null,
        changed.resolvedAt ?? null,
        changed.expiresAt ?? null,
        changed.remindAt ?? null,
        changed.tenantId,
        changed.pauseId,
        was,
      );
    return changes > 0;
  }
}
