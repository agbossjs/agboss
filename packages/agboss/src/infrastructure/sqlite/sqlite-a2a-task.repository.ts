import { Injectable } from "../../components/decorators.js";
import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  firstA2AMessageOf,
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
  answerOf,
  messageKeyOf,
  messageOf,
  MESSAGE_KEY,
  ownerColumnOf,
  MESH_BODY_HASH_COLUMN,
  SCHEMA,
  taskOf,
  TERMINAL_STATES,
} from "./sqlite-a2a-task-rows.js";
import { sqliteA2ATaskPageOf } from "./sqlite-a2a-task-pages.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";

/**
 * `A2ATaskRepository` on the application's SQLite file (#807): a task row and a row per accepted
 * message; the status as JSON. Every write that checks first is one `BEGIN IMMEDIATE`
 * transaction, so of two instances accepting one message exactly one saves it, and of two
 * compare-and-sets at one version exactly one writes. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteA2ATaskRepository extends A2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "sqlite" };

  constructor(private readonly connection: SqliteConnection) {
    super();
    // Stryker disable next-line StringLiteral: the name only keeps the schema run once per connection
    connection.ensureSchema("a2a_tasks", SCHEMA);
    connection.addColumn(...MESH_BODY_HASH_COLUMN);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    return answerOf(() =>
      this.connection.transaction((): A2ATaskSave => {
        const kept = this.#message(task);
        if (kept !== undefined)
          return { status: A2ATaskSaveStatus.MessageTaken, message: kept, task: this.#task(kept) };
        if (this.#task(task) !== undefined) return { status: A2ATaskSaveStatus.TaskIdTaken };
        const record = savedA2ATaskOf(task);
        this.connection.database
          .prepare(
            `INSERT INTO a2a_tasks (tenant_id, task_id, owner_id, context_id, skill, state, status,
              version, accepted_at, status_at, caller_peer, mesh_body_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
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
            record.meshBodyHash ?? null,
          );
        this.#insertMessage(firstA2AMessageOf(task));
        return { status: A2ATaskSaveStatus.Saved, task: record };
      }),
    );
  }

  saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined> {
    return answerOf(() =>
      this.connection.transaction(() => {
        const found = this.#message(message);
        if (found === undefined) this.#insertMessage(message);
        return found;
      }),
    );
  }

  saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean> {
    return answerOf(() => {
      const { changes } = this.connection.database
        .prepare(`UPDATE a2a_messages SET reply = ? WHERE ${MESSAGE_KEY} AND reply IS NULL`)
        .run(JSON.stringify(reply), ...messageKeyOf(key));
      return Number(changes) === 1;
    });
  }

  findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    return answerOf(() => this.#task(key));
  }

  findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined> {
    return answerOf(() => this.#message(key));
  }

  compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const terminal = TERMINAL_STATES.map(() => "?").join(", ");
    return answerOf(() =>
      this.connection.transaction(() => {
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
      }),
    );
  }

  list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    return answerOf(() => sqliteA2ATaskPageOf(this.connection.database, query));
  }

  deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const terminal = TERMINAL_STATES.map(() => "?").join(", ");
    const gone = `state IN (${terminal}) AND status_at < ?`;
    return answerOf(() => {
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
    });
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
