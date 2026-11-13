import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PauseResolution, PauseStatus, type PauseRecord } from "../pause-record.js";
import { pauseRecordOfJson } from "../stored-pause.js";

/**
 * A pause row of `SqlitePausedExecutionRepository` read and written (#267 S35, S107): its columns
 * and the JSON it keeps, each validated on the way out; a row stored by an earlier version reads
 * with defaults (no copy number: the first copy; no resolution column: its status says).
 */

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

/** The JSON a column keeps. */
const JsonObject = z.record(z.string(), z.unknown());
const parsed = (text: string): unknown => JSON.parse(text);

/**
 * A row as the record it keeps: its JSON with its columns laid over it, read as a store reads a
 * pause (`pauseRecordOfJson`: either shape of the names, its answer column checked inside; an
 * unreadable value names the pause and the field).
 */
export function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  return pauseRecordOfJson({
    ...JsonObject.parse(parsed(r.pause)),
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    stepKey: r.step_key,
    rootExecutionId: r.root_execution_id,
    status: r.status,
    isSent: r.is_sent === 1,
    ...(r.answer === null ? {} : { answer: parsed(r.answer) }),
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
    closedFirst: pause.closedFirst,
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
      .prepare("SELECT * FROM pauses WHERE tenant_id = ? AND root_execution_id = ? ORDER BY seq")
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
