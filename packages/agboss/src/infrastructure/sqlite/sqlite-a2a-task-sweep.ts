import type { DatabaseSync } from "node:sqlite";
import { DIRECT_MESSAGE_CLAIM } from "../in-memory-a2a-direct-message.repository.js";
import { TERMINAL_STATES } from "./sqlite-a2a-task-rows.js";

/**
 * The recovery sweep of `SqliteA2ATaskRepository` (#807, #960), inside the caller's transaction:
 * the finished tasks whose status changed before `cutoff` with their messages, then every message
 * whose task is gone and whose `savedAt` is before it — a follow-up saved while its task was removed;
 * never a direct message's claim, which has no task by design (#860).
 */
export function sweepSqliteA2ATasks(database: DatabaseSync, cutoff: Date): void {
  const terminal = TERMINAL_STATES.map(() => "?").join(", ");
  const gone = `state IN (${terminal}) AND status_at < ?`;
  const before = cutoff.toISOString();
  database
    .prepare(
      `DELETE FROM a2a_messages WHERE EXISTS (SELECT 1 FROM a2a_tasks t WHERE
       t.tenant_id = a2a_messages.tenant_id AND t.task_id = a2a_messages.task_id AND ${gone})`,
    )
    .run(...TERMINAL_STATES, before);
  database.prepare(`DELETE FROM a2a_tasks WHERE ${gone}`).run(...TERMINAL_STATES, before);
  database
    .prepare(
      `DELETE FROM a2a_messages WHERE saved_at < ? AND task_id <> ? AND NOT EXISTS (SELECT 1 FROM a2a_tasks t
       WHERE t.tenant_id = a2a_messages.tenant_id AND t.task_id = a2a_messages.task_id)`,
    )
    .run(before, DIRECT_MESSAGE_CLAIM);
}
