import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { storedTextOf } from "./schema.js";
import type { PauseAnswerEntry, Turn, TurnOutcome, TurnStore } from "./types.js";

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

const COMPLETE = `UPDATE terns SET replyWith = ?, status = ?, stop_reason = ?, route = ?, steps = ?,
  cost_usd = ? WHERE id = ?`;

/** A write to a thread's Turn is its activity: what a memory's `ttl` counts from (#1303). */
const TOUCH_THREAD = `UPDATE threads SET last_active_at = ?, is_swept = 0 WHERE tenant_id = ? AND id = ?`;
const TOUCH_THREAD_OF_TURN = `UPDATE threads SET last_active_at = ?, is_swept = 0 WHERE (tenant_id, id) =
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
  db.prepare(TOUCH_THREAD).run(t.createdAt, t.tenantId, t.threadId);
}

/** Appending a Turn and completing it — unconditionally, or only from an expected status (#265 S66 h). */
export function turnWrites(
  db: DatabaseSync,
  now: Now,
): Pick<TurnStore, "append" | "complete" | "completeIfStatus"> {
  return {
    complete: (id, o) => {
      inWriteTransaction(db, () => {
        db.prepare(COMPLETE).run(...outcomeParams(o), id);
        db.prepare(TOUCH_THREAD_OF_TURN).run(now().toISOString(), id);
      });
      return Promise.resolve();
    },
    // one transaction: atomic, also between two connections to one file
    completeIfStatus: (id, expected, o) => {
      const isDone = inWriteTransaction(db, () => {
        const { changes } = db
          .prepare(`${COMPLETE} AND status = ?`)
          .run(...outcomeParams(o), id, expected);
        if (Number(changes) !== 1) return false;
        db.prepare(TOUCH_THREAD_OF_TURN).run(now().toISOString(), id);
        return true;
      });
      return Promise.resolve(isDone);
    },
    append: (turn) => {
      const t: Turn = { ...turn, id: randomUUID(), createdAt: now().toISOString() };
      inWriteTransaction(db, () => {
        insertTurn(db, t);
      });
      return Promise.resolve(t);
    },
  };
}

/** What a kept pause answer is keyed by: its step's key and when it was asked (the whole of it as JSON). */
interface KeptPauseAnswer {
  readonly step: { readonly idempotencyKey: string };
  readonly askedAt: string;
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
  askedAt: answer.askedAt,
  record: JSON.stringify(answer),
});
