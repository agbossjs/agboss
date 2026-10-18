import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Tern, TernOutcome, TernStore } from "./types.js";

type Clock = () => Date;

const COMPLETE = `UPDATE terns SET replyWith = ?, status = ?, stop_reason = ?, route = ?, steps = ?,
  cost_usd = ? WHERE id = ?`;

const outcomeParams = (o: TernOutcome): SQLInputValue[] => [
  o.replyWith,
  o.status,
  o.stopReason,
  JSON.stringify(o.route),
  JSON.stringify(o.steps),
  o.costUsd,
];

/** Appending a Tern and completing it — unconditionally, or only from an expected status (#265 S66 h). */
export function ternWrites(
  db: DatabaseSync,
  now: Clock,
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
           config_hash, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id,
        t.threadId,
        t.bundle,
        t.createdAt,
        t.task,
        t.replyWith,
        t.status,
        t.stopReason,
        JSON.stringify(t.route),
        JSON.stringify(t.steps),
        t.costUsd,
        t.promptVersion,
        t.modelVersion,
        t.replayOf,
        t.configVersion,
        t.configHash,
        t.runId,
      );
      return Promise.resolve(t);
    },
  };
}
