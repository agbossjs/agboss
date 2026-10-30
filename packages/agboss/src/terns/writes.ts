import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { storedTextOf } from "./schema.js";
import type { Tern, TernOutcome, TernStore } from "./types.js";

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

const COMPLETE = `UPDATE terns SET replyWith = ?, status = ?, stop_reason = ?, route = ?, steps = ?,
  cost_usd = ? WHERE id = ?`;

const outcomeParams = (o: TernOutcome): SQLInputValue[] => [
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
): Pick<TernStore, "appendPauseAnswer" | "pauseAnswersOf"> {
  return {
    appendPauseAnswer: (entry) => {
      db.prepare(
        `INSERT OR IGNORE INTO pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
         VALUES (?, ?, ?, ?, ?)`,
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

/** Appending a Tern and completing it — unconditionally, or only from an expected status (#265 S66 h). */
export function ternWrites(
  db: DatabaseSync,
  now: Now,
): Pick<TernStore, "append" | "complete" | "completeIfStatus"> {
  return {
    complete: (id, o) => {
      db.prepare(COMPLETE).run(...outcomeParams(o), id);
      return Promise.resolve();
    },
    // one statement: atomic, also between two connections to one file
    completeIfStatus: (id, expected, o) => {
      const { changes } = db
        .prepare(`${COMPLETE} AND status = ?`)
        .run(...outcomeParams(o), id, expected);
      return Promise.resolve(Number(changes) === 1);
    },
    append: (tern) => {
      const t: Tern = { ...tern, id: randomUUID(), createdAt: now().toISOString() };
      db.prepare(
        `INSERT INTO terns (id, thread_id, bundle, created_at, task, replyWith, status, stop_reason,
           route, steps, cost_usd, prompt_version, model_version, replay_of, config_version,
           config_hash, run_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id,
        t.threadId,
        t.bundle,
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
      return Promise.resolve(t);
    },
  };
}
