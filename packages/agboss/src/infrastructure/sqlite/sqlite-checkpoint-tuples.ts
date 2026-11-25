import type { DatabaseSync } from "node:sqlite";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import {
  CheckpointRow,
  checkpointOf,
  configOf,
  metadataOf,
  WriteRow,
  type PendingWrites,
} from "./sqlite-checkpoint-rows.js";

/**
 * A checkpoint as the SQLite saver reads it (#1317): its row and its pending writes' rows, read in
 * one served group of statements, then decoded by the serde with no statement left — the gate
 * covers a read only up to its first `await`, so no row is read after one.
 */
export interface StoredCheckpoint {
  readonly row: CheckpointRow;
  readonly writes: readonly WriteRow[];
}

/** A checkpoint row with its pending writes' rows: synchronous, one group with the row's own read. */
export function storedWithWrites(
  database: DatabaseSync,
  found: Record<string, unknown>,
): StoredCheckpoint {
  const row = CheckpointRow.parse(found);
  const writes = database
    .prepare(
      `SELECT task_id, channel, value_type, value FROM checkpoint_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid`,
    )
    .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id)
    .map((write) => WriteRow.parse(write));
  return { row, writes };
}

/** The tuple of rows already read: the serde's work only, no statement. */
export async function tupleOf(
  serde: BaseCheckpointSaver["serde"],
  { row, writes }: StoredCheckpoint,
): Promise<CheckpointTuple> {
  const checkpoint = checkpointOf(await serde.loadsTyped(row.checkpoint_type, row.checkpoint));
  const metadata = metadataOf(await serde.loadsTyped(row.metadata_type, row.metadata));
  const pendingWrites: PendingWrites = await Promise.all(
    writes.map(async (write): Promise<PendingWrites[number]> => [
      write.task_id,
      write.channel,
      await serde.loadsTyped(write.value_type, write.value),
    ]),
  );
  const tuple: CheckpointTuple = {
    config: configOf(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
    checkpoint,
    metadata,
    pendingWrites,
  };
  return row.parent_checkpoint_id === null
    ? tuple
    : {
        ...tuple,
        parentConfig: configOf(row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id),
      };
}
