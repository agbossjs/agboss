import { Injectable } from "../../components/decorators.js";
import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  A2ATaskState,
  firstA2AMessageOf,
  isTerminalA2ATaskState,
  savedA2ATaskOf,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type NewA2ATask,
} from "../a2a-task.repository.js";
import {
  messageKeyOf,
  messageOf,
  MESSAGE_KEY,
  ownerColumnOf,
  taskOf,
} from "./sqlite-a2a-task-rows.js";
import { a2aPagePositionOf, a2aPageTokenOf } from "../a2a-task-pages.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const TERMINAL_STATES = Object.values(A2ATaskState).filter(isTerminalA2ATaskState);

const SCHEMA = `CREATE TABLE IF NOT EXISTS a2a_tasks (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  context_id TEXT NOT NULL, skill TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, accepted_at TEXT NOT NULL, status_at TEXT NOT NULL, caller_peer TEXT,
  PRIMARY KEY (tenant_id, task_id));
CREATE INDEX IF NOT EXISTS a2a_tasks_by_owner
  ON a2a_tasks (tenant_id, owner_id, status_at DESC, task_id DESC);
CREATE TABLE IF NOT EXISTS a2a_messages (
  tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, task_id TEXT NOT NULL, saved_at TEXT NOT NULL, reply TEXT,
  PRIMARY KEY (tenant_id, owner_id, message_id));
CREATE INDEX IF NOT EXISTS a2a_messages_by_task ON a2a_messages (tenant_id, task_id);`;

/**
 * `A2ATaskRepository` on the application's SQLite file (#807): a task row and a row per accepted
 * message; the status as JSON. Every write that checks first is one `BEGIN IMMEDIATE`
 * transaction, so of two instances accepting one message exactly one saves it, and of two
 * compare-and-sets at one version exactly one writes. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteA2ATaskRepository extends A2ATaskRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.ensureSchema("a2a_tasks", SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    const saved = this.connection.transaction((): A2ATaskSave => {
      const kept = this.#message(task);
      if (kept !== undefined)
        return { status: A2ATaskSaveStatus.MessageTaken, message: kept, task: this.#task(kept) };
      if (this.#task(task) !== undefined) return { status: A2ATaskSaveStatus.TaskIdTaken };
      const record = savedA2ATaskOf(task);
      this.connection.database
        .prepare("INSERT INTO a2a_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.tenantId,
          record.taskId,
          ownerColumnOf(record.ownerId),
          record.contextId,
          record.skill,
          record.status.state,
          JSON.stringify(record.status),
          record.version,
          record.acceptedAt.toISOString(),
          record.statusAt.toISOString(),
          record.callerPeer ?? null,
        );
      this.#insertMessage(firstA2AMessageOf(task));
      return { status: A2ATaskSaveStatus.Saved, task: record };
    });
    return Promise.resolve(saved);
  }

  saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined> {
    const kept = this.connection.transaction(() => {
      const found = this.#message(message);
      if (found === undefined) this.#insertMessage(message);
      return found;
    });
    return Promise.resolve(kept);
  }

  saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(`UPDATE a2a_messages SET reply = ? WHERE ${MESSAGE_KEY} AND reply IS NULL`)
      .run(JSON.stringify(reply), ...messageKeyOf(key));
    return Promise.resolve(Number(changes) === 1);
  }

  findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    return Promise.resolve(this.#task(key));
  }

  findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined> {
    return Promise.resolve(this.#message(key));
  }

  compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const terminal = TERMINAL_STATES.map(() => "?").join(", ");
    const written = this.connection.transaction(() => {
      const { changes } = this.connection.database
        .prepare(
          `UPDATE a2a_tasks SET state = ?, status = ?, version = version + 1, status_at = ?
           WHERE tenant_id = ? AND task_id = ? AND version = ? AND state NOT IN (${terminal})`,
        )
        .run(
          status.state,
          JSON.stringify(status),
          statusAt.toISOString(),
          key.tenantId,
          key.taskId,
          expectedVersion,
          ...TERMINAL_STATES,
        );
      return Number(changes) === 1 ? this.#task(key) : undefined;
    });
    return Promise.resolve(written);
  }

  list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    // a refused page token rejects the call, never throws
    return new Promise((resolve) => {
      resolve(this.#page(query));
    });
  }

  #page(query: A2ATaskQuery): A2ATaskPage {
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
    if (position !== undefined) {
      where.push("(status_at < ? OR (status_at = ? AND task_id < ?))");
      const at = new Date(position.statusAt).toISOString();
      values.push(at, at, position.taskId);
    }
    const rows = this.connection.database
      .prepare(
        `SELECT * FROM a2a_tasks WHERE ${where.join(" AND ")}
         ORDER BY status_at DESC, task_id DESC LIMIT ?`,
      )
      .all(...values, query.pageSize + 1);
    const tasks = rows.slice(0, query.pageSize).map(taskOf);
    const last = tasks.at(-1);
    const isLast = last === undefined || rows.length <= query.pageSize;
    return { tasks, nextPageToken: isLast ? "" : a2aPageTokenOf(last) };
  }

  deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const terminal = TERMINAL_STATES.map(() => "?").join(", ");
    const gone = `state IN (${terminal}) AND status_at < ?`;
    this.connection.transaction(() => {
      const { database } = this.connection;
      database
        .prepare(
          `DELETE FROM a2a_messages WHERE EXISTS (SELECT 1 FROM a2a_tasks t WHERE
           t.tenant_id = a2a_messages.tenant_id AND t.task_id = a2a_messages.task_id AND ${gone})`,
        )
        .run(...TERMINAL_STATES, cutoff.toISOString());
      database
        .prepare(`DELETE FROM a2a_tasks WHERE ${gone}`)
        .run(...TERMINAL_STATES, cutoff.toISOString());
    });
    return Promise.resolve();
  }

  #task(key: A2ATaskKey): A2ATaskRecord | undefined {
    const row = this.connection.database
      .prepare("SELECT * FROM a2a_tasks WHERE tenant_id = ? AND task_id = ?")
      .get(key.tenantId, key.taskId);
    return row === undefined ? undefined : taskOf(row);
  }

  #message(key: A2AMessageKey): A2AMessageRecord | undefined {
    const row = this.connection.database
      .prepare(`SELECT * FROM a2a_messages WHERE ${MESSAGE_KEY}`)
      .get(...messageKeyOf(key));
    return row === undefined ? undefined : messageOf(row);
  }

  #insertMessage(message: A2AMessageRecord): void {
    this.connection.database
      .prepare("INSERT INTO a2a_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.tenantId,
        ownerColumnOf(message.ownerId),
        message.messageId,
        message.requestHash,
        message.taskId,
        message.savedAt.toISOString(),
        message.reply === undefined ? null : JSON.stringify(message.reply),
      );
  }
}

sqliteImplementation(SqliteA2ATaskRepository);
