import type { DatabaseSync } from "node:sqlite";
import type { SqliteConnection } from "./sqlite-connection.js";
import { z } from "zod";
import { answerOf, askOfStored, componentOfStored, StoredLoopProgress } from "../stored-step.js";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
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
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`;

export const PAUSES_INDEXES = `CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

export const PAUSES_SCHEMA = `${PAUSES_TABLE}\n${PAUSES_INDEXES}`;

/**
 * #663: a file whose pauses were unique per step key of a tenant — the table rebuilt unique per
 * step key of a tree, its rows in their order (`findAllByRoot` reads by `rowid`). Its indexes
 * follow the renamed table and go with it; they are made again on the new one.
 */
const PAUSE_COLUMNS = `tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer,
  resolution, resolved_at`;
const PAUSES_TREE_MIGRATION = `ALTER TABLE pauses RENAME TO pauses_before_trees;
${PAUSES_TABLE}
INSERT INTO pauses (${PAUSE_COLUMNS}) SELECT ${PAUSE_COLUMNS} FROM pauses_before_trees ORDER BY rowid;
DROP TABLE pauses_before_trees;
${PAUSES_INDEXES}`;

/**
 * The migration of a file written before the pause answer records (#267 S107): the answer column
 * was named `resolution`; how and when a pause was resolved get columns of their own.
 */
const PAUSE_ANSWERS_MIGRATION = `ALTER TABLE pauses RENAME COLUMN resolution TO answer;
ALTER TABLE pauses ADD COLUMN resolution TEXT;
ALTER TABLE pauses ADD COLUMN resolved_at TEXT;
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

/**
 * 0.1.1: a pause stores its `kind` and names its `step` (`agent` before). A row written before is
 * rewritten once, by the rule it was written under: a question role's component is a question,
 * every other pause an approval (an approval's row from before components, #268 S93, too). Rows
 * that have a `kind` are left as they are, so it runs at every open and changes a file once; a row
 * that is not JSON is left to fail its own read. A file opened by 0.1.1 is not read by 0.1.0 again.
 */
const PAUSE_KIND_MIGRATION = `UPDATE pauses SET pause = json_set(json_remove(pause, '$.agent'), '$.step', json_extract(pause, '$.agent'),
    '$.kind', CASE json_extract(pause, '$.component.kind') WHEN 'question' THEN 'question' ELSE 'approval' END)
  WHERE json_valid(pause) AND json_type(pause, '$.kind') IS NULL AND json_type(pause, '$.agent') = 'text';`;

/** Migrates a file's pauses written by an older version (inside a transaction): S107, #663, 0.1.1. */
export function migratePauses(connection: SqliteConnection): void {
  const columns = connection.columnsOf("pauses");
  if (columns.length > 0 && !columns.includes("resolved_at"))
    connection.database.exec(PAUSE_ANSWERS_MIGRATION);
  // #663: unique per step key of a tenant — a pause of another tree with that step key hits it
  if (connection.uniqueIndexesOf("pauses").includes("tenant_id,step_key"))
    connection.database.exec(PAUSES_TREE_MIGRATION);
  if (columns.length > 0) connection.database.exec(PAUSE_KIND_MIGRATION);
}

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
  kind: z.enum(PauseKind),
  step: z.string(),
  ...StoredLoopProgress,
  channel: z.string(),
  // a pause stored before #337 has none: its own step's key is its only branch key
  branchKeys: z.array(z.string()).optional(),
  answeredBy: z.enum(PauseAnswerer),
  ask: z.record(z.string(), z.unknown()), // a tool call, or a role's ask (#659, #712): `kind` says
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

/** How a row was resolved: its column, else (a row stored before #267 S107) its status says. */
function resolutionOf(r: z.infer<typeof PauseRow>): PauseResolution | undefined {
  if (r.resolution !== null) return r.resolution;
  if (r.status === PauseStatus.Cancelled) return PauseResolution.Cancelled;
  return r.answer === null ? undefined : PauseResolution.Replied;
}

/** A row as the record it keeps. */
function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  const parsed = StoredPause.safeParse(JSON.parse(r.pause));
  if (!parsed.success)
    throw new Error(`pause ${r.pause_id} (${r.tenant_id}) unreadable: ${parsed.error.message}`);
  const { itemIndex, component, branchKeys, ask, ...stored } = parsed.data;
  const record = component === undefined ? undefined : componentOfStored(component);
  const pause: PauseRecord = {
    ...stored,
    ask: askOfStored(ask, stored.kind === PauseKind.Question),
    ...(record === undefined ? {} : { component: record }),
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
    kind: pause.kind,
    step: pause.step,
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
