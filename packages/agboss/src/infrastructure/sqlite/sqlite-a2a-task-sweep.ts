import type { DatabaseSync } from "node:sqlite";
import { DIRECT_MESSAGE_CLAIM } from "../in-memory-a2a-direct-message.repository.js";
import { TERMINAL_STATES } from "./sqlite-a2a-task-rows.js";

/**
 * The recovery sweep of `SqliteA2ATaskRepository` (#807, #960, #1320), inside the caller's
 * transaction, endpoint by endpoint: the finished tasks of the endpoint whose status changed before
 * its cutoff with their messages, then every message of the endpoint whose task is gone and whose
 * `savedAt` is before it — a follow-up saved while its task was removed; never a direct message's
 * claim, which has no task by design (#860). The number of tasks removed.
 */
export function sweepSqliteA2ATasks(
  database: DatabaseSync,
  cutoffsByEndpoint: ReadonlyMap<string, Date>,
): number {
  const terminal = TERMINAL_STATES.map(() => "?").join(", ");
  // unqualified: inside the messages' subquery the names are the tasks' (the innermost table's), as in the delete of tasks
  const gone = `endpoint = ? AND state IN (${terminal}) AND status_at < ?`;
  let removed = 0;
  for (const [endpoint, cutoff] of cutoffsByEndpoint) {
    const before = cutoff.toISOString();
    database
      .prepare(
        `DELETE FROM a2a_messages WHERE EXISTS (SELECT 1 FROM a2a_tasks t WHERE
         t.tenant_id = a2a_messages.tenant_id AND t.task_id = a2a_messages.task_id AND ${gone})`,
      )
      .run(endpoint, ...TERMINAL_STATES, before);
    const { changes } = database
      .prepare(`DELETE FROM a2a_tasks WHERE ${gone}`)
      .run(endpoint, ...TERMINAL_STATES, before);
    removed += Number(changes);
    database
      .prepare(
        `DELETE FROM a2a_messages WHERE endpoint = ? AND saved_at < ? AND task_id <> ? AND NOT EXISTS
         (SELECT 1 FROM a2a_tasks t WHERE t.tenant_id = a2a_messages.tenant_id
          AND t.task_id = a2a_messages.task_id)`,
      )
      .run(endpoint, before, DIRECT_MESSAGE_CLAIM);
  }
  return removed;
}
