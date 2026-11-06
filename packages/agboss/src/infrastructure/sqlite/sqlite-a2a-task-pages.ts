import type { DatabaseSync } from "node:sqlite";
import type { A2ATaskPage, A2ATaskQuery } from "../a2a-task.repository.js";
import { a2aPagePositionOf, nextPageTokenOf } from "../a2a-task-pages.js";
import { ownerColumnOf, taskOf, totalOf } from "./sqlite-a2a-task-rows.js";

/**
 * `list` of `SqliteA2ATaskRepository` (#807, #824): a caller's tasks newest status first, filtered
 * by context, state and status time, a page after the token's position, and how many the filters
 * match before paging (a second read, no write lock: a task saved in between moves the count by
 * one, as a next page would).
 */
export function sqliteA2ATaskPageOf(database: DatabaseSync, query: A2ATaskQuery): A2ATaskPage {
  const token = query.pageToken ?? "";
  const position = token === "" ? undefined : a2aPagePositionOf(token);
  const where = ["tenant_id = ?", "owner_id = ?"];
  const values: (string | number)[] = [query.tenantId, ownerColumnOf(query.ownerId)];
  if (query.contextId !== undefined) {
    where.push("context_id = ?");
    values.push(query.contextId);
  }
  if (query.state !== undefined) {
    where.push("state = ?");
    values.push(query.state);
  }
  if (query.statusAtAfter !== undefined) {
    where.push("status_at > ?");
    values.push(query.statusAtAfter.toISOString());
  }
  const matching = where.join(" AND ");
  const after = [...where];
  const afterValues = [...values];
  if (position !== undefined) {
    after.push("(status_at < ? OR (status_at = ? AND task_id < ?))");
    const at = new Date(position.statusAt).toISOString();
    afterValues.push(at, at, position.taskId);
  }
  const rows = database
    .prepare(
      `SELECT * FROM a2a_tasks WHERE ${after.join(" AND ")}
       ORDER BY status_at DESC, task_id DESC LIMIT ?`,
    )
    .all(...afterValues, query.pageSize + 1);
  const tasks = rows.slice(0, query.pageSize).map(taskOf);
  // a second read, no write lock: a task saved in between moves the count by one, as a next page would
  const counted = database
    .prepare(`SELECT count(*) AS total FROM a2a_tasks WHERE ${matching}`)
    .get(...values);
  return {
    tasks,
    nextPageToken: nextPageTokenOf(tasks, rows.length > query.pageSize),
    totalSize: totalOf(counted),
  };
}
