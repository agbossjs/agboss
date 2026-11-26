import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { StatusLog } from "./status-log.js";
import { recordTransitionOf, type StatusContext } from "./status-transition.js";
import { storedTextOf } from "./schema.js";
import type { PauseAnswerEntry, Turn, TurnOutcome, TurnStore, TurnTree } from "./types.js";
import type { TurnStatus } from "./types.js";

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

const COMPLETE = `UPDATE terns SET replyWith = ?, status = ?, stop_reason = ?, route = ?, steps = ?,
  cost_usd = ? WHERE id = ?`;

/** A write to a thread's Turn is its activity: what a memory's `ttl` counts from (#1303). */
const TOUCH_THREAD = `UPDATE threads SET last_active_at = ? WHERE tenant_id = ? AND id = ? AND is_swept = 0`;
const TOUCH_THREAD_OF_TURN = `UPDATE threads SET last_active_at = ? WHERE (tenant_id, id) =
  (SELECT tenant_id, thread_id FROM terns WHERE id = ?)`;

/**
 * Runs `write` in one write transaction, so a Turn's outcome and its thread's activity land together
 * (the idle sweep never sees a finished Turn on a thread that looks idle): `BEGIN IMMEDIATE`, unless
 * the connection already is in a transaction.
 */
function inWriteTransaction<T>(db: DatabaseSync, write: () => T): T {
  const isOpen = (): boolean => db.isTransaction;
  if (isOpen()) return write();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (isOpen()) db.exec("ROLLBACK");
    throw error;
  }
}

const outcomeParams = (o: TurnOutcome): SQLInputValue[] => [
  storedTextOf(o.replyWith),
  o.status,
  storedTextOf(o.stopReason),
  JSON.stringify(o.route),
  JSON.stringify(o.steps),
  o.costUsd,
];

const PauseAnswerRow = z.object({ record: z.string() });

/** The pause answer log (#267 S107): an entry kept once per pause, read per tree in the order asked. */
export function pauseAnswerWrites(
  db: DatabaseSync,
): Pick<TurnStore, "appendPauseAnswer" | "markNotTaken" | "pauseAnswersOf"> {
  return {
    appendPauseAnswer: (entry) => {
      db.prepare(
        `INSERT OR IGNORE INTO pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(entry.tenantId, entry.rootExecutionId, entry.stepKey, entry.askedAt, entry.record);
      return Promise.resolve();
    },
    // the entry's place (`asked_at`, row) stays: only its record is replaced
    markNotTaken: (entry) => {
      db.prepare(
        `INSERT INTO pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, root_execution_id, step_key) DO UPDATE SET record = excluded.record`,
      ).run(entry.tenantId, entry.rootExecutionId, entry.stepKey, entry.askedAt, entry.record);
      return Promise.resolve();
    },
    pauseAnswersOf: (tenantId, rootExecutionId) => {
      const rows = db
        .prepare(
          `SELECT record FROM pause_answers WHERE tenant_id = ? AND root_execution_id = ?
           ORDER BY asked_at, rowid`,
        )
        .all(tenantId, rootExecutionId);
      return Promise.resolve(rows.map((row) => PauseAnswerRow.parse(row).record));
    },
  };
}

/** The row of a Turn, and its thread's activity (the caller's transaction holds both). */
function insertTurn(db: DatabaseSync, t: Turn): void {
  // a swept thread (#1303c) takes no record until its owner creates it again: the tombstone is
  // cleared only by `createThread`, which checks the owner
  const { changes } = db.prepare(TOUCH_THREAD).run(t.createdAt, t.tenantId, t.threadId);
  if (Number(changes) !== 1)
    throw new Error("the thread was swept: its owner restarts it by creating it again");
  db.prepare(
    `INSERT INTO terns (id, thread_id, bundle, created_at, task, replyWith, status, stop_reason,
         route, steps, cost_usd, prompt_version, model_version, replay_of, config_version,
         config_hash, run_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.threadId,
    t.workflow,
    t.createdAt,
    storedTextOf(t.task),
    storedTextOf(t.replyWith),
    t.status,
    storedTextOf(t.stopReason),
    JSON.stringify(t.route),
    JSON.stringify(t.steps),
    t.costUsd,
    t.promptVersion,
    t.modelVersion,
    t.replayOf,
    t.configVersion,
    t.configHash,
    t.runId,
    t.tenantId,
  );
}

/** The thread of a Turn, read inside the caller's transaction (the history is the thread's). */
const ThreadOfTurn = z.object({ tenant_id: z.string(), thread_id: z.string() });

/**
 * The status change a write of `status` makes, appended to the thread's history in the write's own
 * transaction (#1341d): a crash between the status and its row is impossible.
 */
function appendedStatus(
  log: StatusLog,
  now: Now,
  thread: { readonly tenantId: string; readonly threadId: string },
  status: TurnStatus,
  context: StatusContext | undefined,
): void {
  const next = recordTransitionOf(thread, status, log.lastOf(thread), context);
  if (next !== undefined) log.appended(next, now());
}

/** The thread a Turn belongs to, by its id. */
function threadOfTurn(
  db: DatabaseSync,
  id: string,
): { readonly tenantId: string; readonly threadId: string } | undefined {
  const row = db.prepare("SELECT tenant_id, thread_id FROM terns WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  const parsed = ThreadOfTurn.parse(row);
  return { tenantId: parsed.tenant_id, threadId: parsed.thread_id };
}

const TreeOfTurn = z.object({ tenant_id: z.string(), run_id: z.string().nullable() });

/** The execution tree a Turn is the root record of (its tenant and run), by its id; none without a run. */
function treeOfTurn(db: DatabaseSync, id: string): TurnTree | undefined {
  const row = db.prepare("SELECT tenant_id, run_id FROM terns WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  const parsed = TreeOfTurn.parse(row);
  return parsed.run_id === null
    ? undefined
    : { tenantId: parsed.tenant_id, rootExecutionId: parsed.run_id };
}

/**
 * A finish's write conditional on its tree's marks (#1341b): `isInterrupted` is asked inside the
 * write's own transaction — a stop or cancel mark is written in a transaction of its own on the same
 * backend —, so the two serialize and a finish never lands over a mark.
 */
export function interruptibleWrites(
  db: DatabaseSync,
  now: Now,
  log: StatusLog,
): Pick<TurnStore, "completeUnlessInterrupted"> {
  return {
    completeUnlessInterrupted: (id, o, context, isInterrupted = () => false) => {
      const isDone = inWriteTransaction(db, () => {
        const tree = treeOfTurn(db, id);
        if (tree !== undefined && isInterrupted(tree)) return false;
        db.prepare(COMPLETE).run(...outcomeParams(o), id);
        db.prepare(TOUCH_THREAD_OF_TURN).run(now().toISOString(), id);
        const thread = threadOfTurn(db, id);
        if (thread !== undefined) appendedStatus(log, now, thread, o.status, context);
        return true;
      });
      return Promise.resolve(isDone);
    },
  };
}

/** Appending a Turn and completing it — unconditionally, or only from an expected status (#265 S66 h). */
export function turnWrites(
  db: DatabaseSync,
  now: Now,
  log: StatusLog,
): Pick<TurnStore, "append" | "complete" | "completeIfStatus"> {
  return {
    complete: (id, o, context) => {
      inWriteTransaction(db, () => {
        db.prepare(COMPLETE).run(...outcomeParams(o), id);
        db.prepare(TOUCH_THREAD_OF_TURN).run(now().toISOString(), id);
        const thread = threadOfTurn(db, id);
        if (thread !== undefined) appendedStatus(log, now, thread, o.status, context);
      });
      return Promise.resolve();
    },
    // one transaction: atomic, also between two connections to one file
    completeIfStatus: (id, expected, o, context) => {
      const isDone = inWriteTransaction(db, () => {
        const { changes } = db
          .prepare(`${COMPLETE} AND status = ?`)
          .run(...outcomeParams(o), id, expected);
        if (Number(changes) !== 1) return false;
        db.prepare(TOUCH_THREAD_OF_TURN).run(now().toISOString(), id);
        const thread = threadOfTurn(db, id);
        if (thread !== undefined) appendedStatus(log, now, thread, o.status, context);
        return true;
      });
      return Promise.resolve(isDone);
    },
    // in a promise's executor: a refused write (a swept thread) rejects, never throws at the call
    append: (turn, context) =>
      new Promise<Turn>((resolve) => {
        const t: Turn = { ...turn, id: randomUUID(), createdAt: now().toISOString() };
        inWriteTransaction(db, () => {
          insertTurn(db, t);
          appendedStatus(log, now, t, t.status, context);
        });
        resolve(t);
      }),
  };
}

/** What a kept pause answer is keyed by: its step's key and when it was asked (the whole of it as JSON). */
interface KeptPauseAnswer {
  readonly step: { readonly idempotencyKey: string };
  readonly askedAt: Date;
}

/** A pause answer as a Turn store keeps it: by its tree and its step key, the record as JSON. */
export const pauseAnswerEntryOf = (
  tenantId: string,
  rootExecutionId: string,
  answer: KeptPauseAnswer,
): PauseAnswerEntry => ({
  tenantId,
  rootExecutionId,
  stepKey: answer.step.idempotencyKey,
  // the Turn store contract keeps the time as ISO 8601 text; P6b types it as a `Date` and drops this conversion
  askedAt: answer.askedAt.toISOString(),
  record: JSON.stringify(answer),
});
