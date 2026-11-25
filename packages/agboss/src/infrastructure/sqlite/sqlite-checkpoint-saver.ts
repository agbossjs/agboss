import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, copyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { Injectable } from "../../components/decorators.js";
import {
  CHECKPOINT_COLUMNS,
  CheckpointRow,
  checkpointOf,
  configOf,
  hasRoot,
  keyOf,
  listQueryOf,
  matchesMetadata,
  metadataOf,
  WriteRow,
  writeIndexOf,
  type PendingWrites,
} from "./sqlite-checkpoint-rows.js";
import type { LatestByStepCheckpointSaver } from "../latest-by-step.js";
import { latestRowOf, newestIdOf, rowOf, stepsToRank } from "./sqlite-latest-by-step.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * LangGraph's `BaseCheckpointSaver` on the application's SQLite file (#265 S32, our own on
 * `node:sqlite` — no second driver): checkpoints and pending writes, serialized by `this.serde`,
 * each row tagged with its run's tenant (#261: `configurable.tenant_id`).
 * Listed in `@Application({ providers })` (needs `sqlitePath`) with `SqlitePausedExecutionRepository`, a
 * pause survives a restart and is resumed on any instance; recovery continues a `running` tree from
 * its last checkpoint. Ecosystem savers (`PostgresSaver`, …) plug in the same way.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteCheckpointSaver
  extends BaseCheckpointSaver
  implements LatestByStepCheckpointSaver
{
  constructor(private readonly connection: SqliteConnection) {
    super();
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
          ? `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
             ORDER BY checkpoint_id DESC LIMIT 1`
          : `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      )
      .get(...[threadId, namespace, ...(checkpointId === undefined ? [] : [checkpointId])]);
    return row === undefined ? undefined : this.#tupleOf(CheckpointRow.parse(row));
  }

  async latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = keyOf(config, "latestByStep");
    const toRank = stepsToRank(this.connection, key);
    // rows whose step SQL cannot read: the winner by the serde, then only its whole row (#1144)
    const id = toRank === undefined ? undefined : await newestIdOf(this.serde, toRank);
    const row =
      toRank === undefined
        ? latestRowOf(this.connection, key)
        : id === undefined
          ? undefined
          : rowOf(this.connection, key, id);
    return row === undefined ? undefined : this.#tupleOf(CheckpointRow.parse(row));
  }

  async *list(
    config: RunnableConfig,
    options: NonNullable<Parameters<BaseCheckpointSaver["list"]>[1]> = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { where, params } = listQueryOf(config, options);
    const rows = this.connection.database
      .prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints ${where} ORDER BY checkpoint_id DESC`)
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
    checkpoint: Parameters<BaseCheckpointSaver["put"]>[1],
    metadata: Parameters<BaseCheckpointSaver["put"]>[2],
  ): Promise<RunnableConfig> {
    const { tenantId, threadId, namespace, checkpointId: parentId, ...key } = keyOf(config, "put");
    const rootId = this.#rootOf(config, threadId, key.rootId);
    const [[checkpointType, dumped], [metadataType, dumpedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    this.connection.transaction(() => {
      this.connection.database
        .prepare(
          `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id,
             parent_checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata, tenant_id, root_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
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
          rootId,
        );
    });
    return configOf(threadId, namespace, checkpoint.id);
  }

  async putWrites(
    ...[config, writes, taskId]: Parameters<BaseCheckpointSaver["putWrites"]>
  ): Promise<void> {
    const { tenantId, threadId, namespace, checkpointId, ...key } = keyOf(config, "putWrites");
    if (checkpointId === undefined) {
      throw new Error("SqliteCheckpointSaver.putWrites: the config has no checkpoint_id");
    }
    const rootId = this.#rootOf(config, threadId, key.rootId);
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
            `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx,
               channel, value_type, value, tenant_id, root_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            rootId,
          );
      }
    });
  }

  /**
   * The tree a thread's rows belong to: the one the config names, else the one the thread's rows
   * already store (the config `put` returns names no root, and a thread's tree never changes),
   * else the thread's first segment.
   */
  #rootOf(config: RunnableConfig, threadId: string, derived: string): string {
    if (hasRoot(config)) return derived;
    const row = this.connection.database
      .prepare("SELECT root_id FROM checkpoints WHERE thread_id = ? LIMIT 1")
      .get(threadId);
    return typeof row?.root_id === "string" ? row.root_id : derived;
  }

  /** The thread and every thread of the tree it roots (#1321d): by the stored `root_id`, never by a range of ids. */
  deleteThread(threadId: string): Promise<void> {
    const { database } = this.connection;
    const where = "thread_id = ? OR root_id = ?";
    this.connection.transaction(() => {
      database.prepare(`DELETE FROM checkpoint_writes WHERE ${where}`).run(threadId, threadId);
      database.prepare(`DELETE FROM checkpoints WHERE ${where}`).run(threadId, threadId);
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
