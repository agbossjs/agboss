import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { componentOfStored, StoredLoopProgress } from "../stored-step.js";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../pause-record.js";

/**
 * The pauses of `SqlitePausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tree (#663); every change of a pending pause is one conditional `UPDATE … WHERE status =
 * 'pending'`, so of two connections exactly one changes it.
 */

/**
 * A pause row of `SqlitePausedExecutionRepository` read and written (#267 S35, S107): its columns
 * and the JSON it keeps, each validated on the way out; a row stored by an earlier version reads
 * with defaults (no copy number: the first copy; no resolution column: its status says).
 */

/** What a pause row keeps as JSON: everything but its id, status, flag and resolution. */
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
  agent: z.string(),
  ...StoredLoopProgress,
  channel: z.string(),
  // a pause stored before #337 has none: its own step's key is its only branch key
  branchKeys: z.array(z.string()).optional(),
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
  answer: z.string().nullable(),
  resolution: z.enum(PauseResolution).nullable(),
  resolved_at: z.string().nullable(),
});

const StoredUsage = z.object({
  caller: z.string(),
  model: z.string(),
  ...{ inputTokens: z.number(), outputTokens: z.number() },
  ...{ cacheReadTokens: z.number(), cacheWriteTokens: z.number() },
  costUsd: z.number(),
  costSource: z.enum(["api", "price-table", "tool"]),
  servedBy: z.string().optional(),
});

const StoredAnswer = z.object({
  decision: z.unknown(),
  answerer: z.string().optional(),
  usage: z.array(StoredUsage).optional(),
});

/** How a row was resolved: its column, else (a row stored before #267 S107) its status says. */
function resolutionOf(r: z.infer<typeof PauseRow>): PauseResolution | undefined {
  if (r.resolution !== null) return r.resolution;
  if (r.status === PauseStatus.Cancelled) return PauseResolution.Cancelled;
  return r.answer === null ? undefined : PauseResolution.Replied;
}

/** The answer a row keeps, as JSON. */
function answerOf(text: string): PauseAnswer {
  const { decision, answerer, usage } = StoredAnswer.parse(JSON.parse(text));
  return { decision, answerer, ...(usage === undefined ? {} : { usage }) };
}

/** A row as the record it keeps. */
function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  const { itemIndex, component, branchKeys, ...stored } = StoredPause.parse(JSON.parse(r.pause));
  const pause: PauseRecord = {
    ...stored,
    ...(component === undefined ? {} : { component: componentOfStored(component) }),
    ...(branchKeys === undefined ? {} : { branchKeys }),
    itemIndex,
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    stepKey: r.step_key,
    rootExecutionId: r.root_execution_id,
    status: r.status,
    isSent: r.is_sent === 1,
  };
  const resolution = resolutionOf(r);
  return {
    ...pause,
    ...(r.answer === null ? {} : { answer: answerOf(r.answer) }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(r.resolved_at === null ? {} : { resolvedAt: r.resolved_at }),
  };
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
    agent: pause.agent,
    component: pause.component,
    toolLoopIteration: pause.toolLoopIteration,
    validationAttempts: pause.validationAttempts,
    channel: pause.channel,
    branchKeys: pause.branchKeys,
    answeredBy: pause.answeredBy,
    ask: pause.ask,
  });

/** The statements of the pauses, on one connection's database. */
export class SqlitePauseRows {
  constructor(private readonly database: DatabaseSync) {}

  /** The pause of the step key in the tenant's tree (#663: never another tree's). */
  findByStepKey({ tenantId, rootExecutionId, stepKey }: PauseRecord): PauseRecord | undefined {
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
