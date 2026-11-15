import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";

/**
 * The rows of `SqliteCheckpointSaver` (#265 S32): tables `checkpoints` (one per checkpoint of a
 * thread and namespace, the parent's id kept) and `checkpoint_writes` (a task's pending writes of
 * one checkpoint), the values as `this.serde` dumps them with their type.
 */

export const CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, checkpoint_type TEXT NOT NULL, checkpoint BLOB NOT NULL,
  metadata_type TEXT NOT NULL, metadata BLOB NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, value_type TEXT NOT NULL,
  value BLOB NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));`;

/**
 * The newest checkpoint of a thread's namespace by `(step, id)` is one index read (#962). `step` is
 * a VIRTUAL generated column: `metadata.step` read from the JSON the saver's serde dumps the metadata
 * as (a missing or non-number one is -2), never stored in the row. A positional `INSERT` of a
 * version before the column (nine values) still works on the file, because SQLite leaves a generated
 * column out of `VALUES` (#1035), and an old row needs no backfill. REAL affinity keeps a step of
 * 2^53 or more a double, as JavaScript reads it (#1036: an INTEGER above 2^53 is a `RangeError`).
 */
export const STEP_COLUMN = `REAL GENERATED ALWAYS AS (COALESCE(
  CASE WHEN metadata_type = 'json'
    AND json_valid(CAST(metadata AS TEXT))
    AND json_type(CAST(metadata AS TEXT), '$.step') IN ('integer', 'real')
    THEN json_extract(CAST(metadata AS TEXT), '$.step') END, -2)) VIRTUAL`;

export const STEP_INDEX = `CREATE INDEX IF NOT EXISTS checkpoints_latest_by_step
  ON checkpoints (thread_id, checkpoint_ns, step DESC, checkpoint_id DESC)`;

/**
 * The rows whose `step` SQL cannot vouch for (#1101, #1114): `step` reads -2. That is a metadata not
 * typed `json` (a serde that names another type, `""` included), bytes that are not plain JSON or
 * have another shape (a serde that keeps the type `json` and encrypts, compresses or envelopes them),
 * or a metadata that truly has no step. SQL cannot tell those apart, so a thread's namespace that
 * has such a row is read by the saver's serde instead: the indexed path never answers what the scan would not. A partial index,
 * empty in the ordinary case (LangGraph's metadata always has a step), makes "has one?" a single probe.
 * It replaces `checkpoints_foreign_metadata` of #1101, which only knew the first kind.
 */
export const UNREADABLE_STEP_INDEX = `CREATE INDEX IF NOT EXISTS checkpoints_unreadable_step
  ON checkpoints (thread_id, checkpoint_ns) WHERE step = -2`;

/** The columns a checkpoint is read with (not `step`, which only orders). */
export const CHECKPOINT_COLUMNS = `thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
  checkpoint_type, checkpoint, metadata_type, metadata`;

/** The read of `latestByStep`: one walk of `checkpoints_latest_by_step`, no sort. */
export const LATEST_BY_STEP_SQL = `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY step DESC, checkpoint_id DESC LIMIT 1`;

/**
 * Whether a thread's namespace holds a row whose `step` SQL cannot vouch for (see above). The
 * `INDEXED BY` is performance only: the answer is the same without it, but a statement the partial
 * index cannot serve fails loudly instead of scanning the namespace.
 */
export const HAS_UNREADABLE_STEP_SQL = `SELECT 1 AS found FROM checkpoints
  INDEXED BY checkpoints_unreadable_step
  WHERE thread_id = ? AND checkpoint_ns = ? AND step = -2 LIMIT 1`;

/**
 * The newest row among those whose `step` SQL reads (not -2), by the index: its id and step, no blob.
 * The walk skips the rows at -2, which sit in the index between the real steps, so it costs the rows at -2.
 */
export const NEWEST_READABLE_STEP_SQL = `SELECT checkpoint_id, step FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? AND step <> -2
  ORDER BY step DESC, checkpoint_id DESC LIMIT 1`;

/** The rows whose `step` SQL cannot vouch for (by the partial index), as much as the serde needs: id and metadata. */
export const UNREADABLE_STEP_ROWS_SQL = `SELECT checkpoint_id, metadata_type, metadata FROM checkpoints
  INDEXED BY checkpoints_unreadable_step
  WHERE thread_id = ? AND checkpoint_ns = ? AND step = -2`;

/** One checkpoint row by its key, every column: the winner of the read by the serde. */
export const CHECKPOINT_ROW_SQL = `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`;

/** The tables `tenant_id` is added to in a file written before tenants (#261, #265 S69 e). */
export const TENANT_TAGGED_TABLES: readonly string[] = ["checkpoints", "checkpoint_writes"];

/** What the saver's methods take (LangGraph's types are not all re-exported). */
export type PutWritesArguments = Parameters<BaseCheckpointSaver["putWrites"]>;
export type Checkpoint = Parameters<BaseCheckpointSaver["put"]>[1];
export type CheckpointMetadata = Parameters<BaseCheckpointSaver["put"]>[2];
export type ListOptions = NonNullable<Parameters<BaseCheckpointSaver["list"]>[1]>;
export type PendingWrites = NonNullable<CheckpointTuple["pendingWrites"]>;

const Blob = z.instanceof(Uint8Array);

export const CheckpointRow = z.object({
  thread_id: z.string(),
  checkpoint_ns: z.string(),
  checkpoint_id: z.string(),
  parent_checkpoint_id: z.string().nullable(),
  checkpoint_type: z.string(),
  checkpoint: Blob,
  metadata_type: z.string(),
  metadata: Blob,
});
export type CheckpointRow = z.infer<typeof CheckpointRow>;

export const WriteRow = z.object({
  task_id: z.string(),
  channel: z.string(),
  value_type: z.string(),
  value: Blob,
});

/**
 * Where a checkpoint is: its thread, namespace and (absent = the latest) id — and the tenant it is
 * tagged with (#261: the run's `configurable.tenant_id`, `"default"` without one).
 */
export interface CheckpointKey {
  readonly tenantId: string;
  readonly threadId: string;
  readonly namespace: string;
  readonly checkpointId: string | undefined;
}

const Configurable = z.object({
  tenant_id: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  checkpoint_ns: z.string().optional(),
  checkpoint_id: z.string().min(1).optional(),
});

/** The key a config names; a missing `thread_id` fails, naming the field. */
export function keyOf(config: RunnableConfig, operation: string): CheckpointKey {
  const configurable = Configurable.parse(config.configurable ?? {});
  if (configurable.thread_id === undefined) {
    throw new Error(
      `SqliteCheckpointSaver.${operation}: the config has no configurable.thread_id — every checkpoint belongs to a thread`,
    );
  }
  return {
    tenantId: configurable.tenant_id ?? "default",
    threadId: configurable.thread_id,
    namespace: configurable.checkpoint_ns ?? "",
    checkpointId: configurable.checkpoint_id,
  };
}

/** The filter of `list(config)`: a thread (or every thread), a namespace, a checkpoint id. */
export const listFilterOf = (config: RunnableConfig): z.infer<typeof Configurable> =>
  Configurable.parse(config.configurable ?? {});

/** The `WHERE` of `list(config, { before })` and its parameters. */
export function listQueryOf(
  config: RunnableConfig,
  options: ListOptions,
): { readonly where: string; readonly params: SQLInputValue[] } {
  const filter = listFilterOf(config);
  const before = options.before === undefined ? undefined : listFilterOf(options.before);
  const conditions: readonly (readonly [string, string | undefined])[] = [
    ["thread_id = ?", filter.thread_id],
    ["checkpoint_ns = ?", filter.checkpoint_ns],
    ["checkpoint_id = ?", filter.checkpoint_id],
    ["checkpoint_id < ?", before?.checkpoint_id],
  ];
  const used = conditions.flatMap(([sql, value]) => (value === undefined ? [] : [{ sql, value }]));
  return {
    where: used.length === 0 ? "" : `WHERE ${used.map((item) => item.sql).join(" AND ")}`,
    params: used.map((item) => item.value),
  };
}

/** Whether a checkpoint's metadata has every field `list`'s `filter` asks for. */
export const matchesMetadata = (tuple: CheckpointTuple, options: ListOptions): boolean => {
  const metadata: Readonly<Record<string, unknown>> = tuple.metadata ?? {};
  return Object.entries(options.filter ?? {}).every(([key, value]) => metadata[key] === value);
};

/** The fields LangGraph reads of a stored checkpoint; the rest passes through as dumped. */
const StoredCheckpoint = z.looseObject({
  v: z.number(),
  id: z.string(),
  ts: z.string(),
  channel_values: z.record(z.string(), z.unknown()),
  channel_versions: z.record(z.string(), z.union([z.number(), z.string()])),
  versions_seen: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))),
});

const isCheckpoint = (value: unknown): value is Checkpoint =>
  StoredCheckpoint.safeParse(value).success;

/** A loaded checkpoint, checked: what `put` dumped. */
export function checkpointOf(loaded: unknown): Checkpoint {
  if (!isCheckpoint(loaded))
    throw new Error("SqliteCheckpointSaver: a stored checkpoint is not readable");
  return loaded;
}

const isMetadata = (value: unknown): value is CheckpointMetadata =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Loaded metadata, checked: an object. */
export function metadataOf(loaded: unknown): CheckpointMetadata {
  if (!isMetadata(loaded))
    throw new Error("SqliteCheckpointSaver: stored metadata is not readable");
  return loaded;
}

/** The config that names one stored checkpoint. */
export const configOf = (
  threadId: string,
  namespace: string,
  checkpointId: string,
): RunnableConfig => ({
  configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId },
});

/** Special channels (errors, interrupts, resumes) get fixed negative indexes (LangGraph's map). */
const SPECIAL_WRITE_INDEXES: Readonly<Record<string, number>> = {
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
};

/** The index of the `position`-th write of a task to `channel`. */
export const writeIndexOf = (channel: string, position: number): number =>
  SPECIAL_WRITE_INDEXES[channel] ?? position;
