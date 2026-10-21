import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, copyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { Injectable } from "../../components/decorators.js";
import {
  CHECKPOINT_SCHEMA,
  TENANT_TAGGED_TABLES,
  CheckpointRow,
  checkpointOf,
  configOf,
  keyOf,
  listQueryOf,
  matchesMetadata,
  metadataOf,
  WriteRow,
  writeIndexOf,
  type Checkpoint,
  type CheckpointMetadata,
  type ListOptions,
  type PendingWrites,
  type PutWritesArguments,
} from "./sqlite-checkpoint-rows.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * LangGraph's `BaseCheckpointSaver` on the application's SQLite file (#265 S32, our own on
 * `node:sqlite` — no second driver): checkpoints and pending writes, serialized by `this.serde`,
 * each row tagged with its run's tenant (#261: `configurable.tenant_id`).
 * Listed in `@Application({ providers })` (needs `sqlitePath`) with `SqlitePausedExecutionRepository`,
 * a pause survives a restart and is resumed on any instance on the file; recovery continues a
 * `running` tree from its last checkpoint. Ecosystem savers (`PostgresSaver`, …) plug in the same way.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.ensureSchema("checkpoints", CHECKPOINT_SCHEMA);
    for (const table of TENANT_TAGGED_TABLES)
      connection.addColumn(table, "tenant_id", "TEXT NOT NULL DEFAULT 'default'");
  }

  /** One `SELECT 1` on the file (#300): what `app.checkReadiness()` asks of the checkpoint saver. */
  ping(): Promise<void> {
    return this.connection.ping();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, namespace, checkpointId } = keyOf(config, "getTuple");
    const row = this.connection.database
      .prepare(
        checkpointId === undefined
          ? `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
             ORDER BY checkpoint_id DESC LIMIT 1`
          : "SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
      )
      .get(...[threadId, namespace, ...(checkpointId === undefined ? [] : [checkpointId])]);
    return row === undefined ? undefined : this.#tupleOf(CheckpointRow.parse(row));
  }

  async *list(config: RunnableConfig, options: ListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const { where, params } = listQueryOf(config, options);
    const rows = this.connection.database
      .prepare(`SELECT * FROM checkpoints ${where} ORDER BY checkpoint_id DESC`)
      .all(...params);
    let left = options.limit ?? Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (left <= 0) return;
      const tuple = await this.#tupleOf(CheckpointRow.parse(row));
      if (!matchesMetadata(tuple, options)) continue;
      left -= 1;
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { tenantId, threadId, namespace, checkpointId: parentId } = keyOf(config, "put");
    const [[checkpointType, dumped], [metadataType, dumpedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    this.connection.transaction(() => {
      this.connection.database
        .prepare("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          threadId,
          namespace,
          checkpoint.id,
          parentId ?? null,
          checkpointType,
          dumped,
          metadataType,
          dumpedMetadata,
          tenantId,
        );
    });
    return configOf(threadId, namespace, checkpoint.id);
  }

  async putWrites(...[config, writes, taskId]: PutWritesArguments): Promise<void> {
    const { tenantId, threadId, namespace, checkpointId } = keyOf(config, "putWrites");
    if (checkpointId === undefined) {
      throw new Error("SqliteCheckpointSaver.putWrites: the config has no checkpoint_id");
    }
    const dumped = await Promise.all(
      writes.map(async ([channel, value], position) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return { channel, index: writeIndexOf(channel, position), type, bytes };
      }),
    );
    const { database } = this.connection;
    this.connection.transaction(() => {
      for (const write of dumped) {
        // a regular write is kept as first written; a special one (an error, …) replaces its own
        const conflict =
          write.index >= 0
            ? "DO NOTHING"
            : "DO UPDATE SET channel = excluded.channel, value_type = excluded.value_type, value = excluded.value";
        database
          .prepare(
            `INSERT INTO checkpoint_writes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) ${conflict}`,
          )
          .run(
            threadId,
            namespace,
            checkpointId,
            taskId,
            write.index,
            write.channel,
            write.type,
            write.bytes,
            tenantId,
          );
      }
    });
  }

  deleteThread(threadId: string): Promise<void> {
    const { database } = this.connection;
    this.connection.transaction(() => {
      database.prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId);
      database.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    });
    return Promise.resolve();
  }

  async #tupleOf(row: CheckpointRow): Promise<CheckpointTuple> {
    const checkpoint = checkpointOf(
      await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint),
    );
    const metadata = metadataOf(await this.serde.loadsTyped(row.metadata_type, row.metadata));
    const tuple: CheckpointTuple = {
      config: configOf(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
      checkpoint,
      metadata,
      pendingWrites: await this.#pendingWritesOf(row),
    };
    return row.parent_checkpoint_id === null
      ? tuple
      : {
          ...tuple,
          parentConfig: configOf(row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id),
        };
  }

  async #pendingWritesOf(row: CheckpointRow): Promise<PendingWrites> {
    const writes = this.connection.database
      .prepare(
        `SELECT task_id, channel, value_type, value FROM checkpoint_writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid`,
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id)
      .map((write) => WriteRow.parse(write));
    return Promise.all(
      writes.map(async (write): Promise<PendingWrites[number]> => [
        write.task_id,
        write.channel,
        await this.serde.loadsTyped(write.value_type, write.value),
      ]),
    );
  }
}

sqliteImplementation(SqliteCheckpointSaver);
