import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { PauseAnswerEntry, TurnStore } from "./types.js";

/** The row a pause answer is kept as: its `asked_at` is the `toISOString()` text of the instant (a column sorts by it). */
const answerParams = (entry: PauseAnswerEntry): SQLInputValue[] => [
  entry.tenantId,
  entry.rootExecutionId,
  entry.stepKey,
  entry.askedAt.toISOString(),
  entry.record,
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
      ).run(...answerParams(entry));
      return Promise.resolve();
    },
    // the entry's place (`asked_at`, row) stays: only its record is replaced
    markNotTaken: (entry) => {
      db.prepare(
        `INSERT INTO pause_answers (tenant_id, root_execution_id, step_key, asked_at, record)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, root_execution_id, step_key) DO UPDATE SET record = excluded.record`,
      ).run(...answerParams(entry));
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
  askedAt: answer.askedAt,
  record: JSON.stringify(answer),
});
