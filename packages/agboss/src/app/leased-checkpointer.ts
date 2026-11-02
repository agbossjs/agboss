import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { HeldExecutionLease } from "./execution-leases.js";

/** What LangGraph's checkpointer contract takes (its types are not all re-exported). */
type ListArguments = Parameters<BaseCheckpointSaver["list"]>;
type PutArguments = Parameters<BaseCheckpointSaver["put"]>;
type PutWritesArguments = Parameters<BaseCheckpointSaver["putWrites"]>;
type CheckpointListOptions = NonNullable<ListArguments[1]>;

/**
 * The application's checkpointer as one pass over a tree sees it (#265, Q58): every write renews
 * the tree's lease first, so a holder that lost it never writes. Documented limit: the renewal and
 * the write are two round trips, not one atomic operation (any `BaseCheckpointSaver` plugs in).
 */
export class LeasedCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly saver: BaseCheckpointSaver,
    private readonly lease: HeldExecutionLease,
  ) {
    super(saver.serde);
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.saver.getTuple(config);
  }

  list(...listArguments: ListArguments): AsyncGenerator<CheckpointTuple> {
    return this.saver.list(...listArguments);
  }

  async put(...putArguments: PutArguments): Promise<RunnableConfig> {
    await this.lease.renewNow();
    return this.saver.put(...putArguments);
  }

  async putWrites(...putWritesArguments: PutWritesArguments): Promise<void> {
    await this.lease.renewNow();
    return this.saver.putWrites(...putWritesArguments);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.saver.deleteThread(threadId);
  }

  override getNextVersion(current: number | undefined): number {
    return this.saver.getNextVersion(current);
  }
}

/**
 * The application's checkpointer, its latest checkpoint the one written last (#682). LangGraph
 * names a checkpoint by a UUIDv6 of `Date.now()` and a saver's latest checkpoint — what LangGraph
 * continues a resume, a recovery or a re-entered child from, and what every read of a thread's
 * state reads — is its greatest id. After a backward step of the host's wall clock (an NTP
 * `settimeofday`) a new checkpoint's id sorts before older ones: the thread's latest is then a
 * stale checkpoint — its later steps run again, what they wrote is forked away. Each `put` whose
 * id is not above its thread's greatest first marks the thread (a checkpoint of its own namespace,
 * `OUT_OF_ORDER`, kept until the thread is deleted); a marked thread's latest checkpoint is its
 * highest LangGraph step (each run of a thread continues at its last checkpoint's step + 1), and
 * its list is in that order. An unmarked thread — every thread whose clock never stepped back —
 * is read as the saver reads it: one more look for the mark per latest read, nothing else.
 */
export class OrderedCheckpointSaver extends BaseCheckpointSaver {
  /** The greatest id of each thread and namespace this instance saw stored. */
  readonly #greatest = new Map<string, string>();
  /** The threads known marked. */
  readonly #marked = new Set<string>();

  constructor(readonly saver: BaseCheckpointSaver) {
    super(saver.serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (idOf(config) !== undefined) return this.saver.getTuple(config);
    if (await this.#isMarked(config)) {
      const [newest] = await this.#ordered(threadOf(config, namespaceOf(config)));
      return newest === undefined ? undefined : this.saver.getTuple(newest.config);
    }
    const tuple = await this.saver.getTuple(config);
    if (tuple !== undefined) this.#see(config, tuple.checkpoint.id);
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    if (!(await this.#isMarked(config))) {
      for await (const tuple of this.saver.list(config, options))
        if (namespaceOf(tuple.config) !== OUT_OF_ORDER) yield tuple;
      return;
    }
    yield* limited(await this.#ordered(config, options), options?.limit);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Parameters<BaseCheckpointSaver["put"]>[3],
  ): Promise<RunnableConfig> {
    const floor = await this.#greatestOf(config);
    if (floor !== undefined && checkpoint.id < floor) await this.#mark(config);
    this.#see(config, checkpoint.id);
    return this.saver.put(config, checkpoint, metadata, newVersions);
  }

  putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>): Promise<void> {
    return this.saver.putWrites(...args);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.saver.deleteThread(threadId);
    this.#marked.delete(threadId);
    for (const key of [...this.#greatest.keys()])
      if (key.startsWith(`${threadId}\u0000`)) this.#greatest.delete(key);
  }

  override getNextVersion(current: number | undefined): number {
    return this.saver.getNextVersion(current);
  }

  /** The thread's greatest stored id: seen here, else read from the saver once. */
  async #greatestOf(config: RunnableConfig): Promise<string | undefined> {
    const key = keyOf(config);
    if (!this.#greatest.has(key)) {
      const latest = await this.saver.getTuple(threadOf(config, namespaceOf(config)));
      if (latest !== undefined) this.#see(config, latest.checkpoint.id);
    }
    return this.#greatest.get(key);
  }

  #see(config: RunnableConfig, id: string): void {
    const key = keyOf(config);
    const known = this.#greatest.get(key);
    if (known === undefined || id > known) this.#greatest.set(key, id);
  }

  async #isMarked(config: RunnableConfig): Promise<boolean> {
    const thread = threadIdOf(config);
    if (this.#marked.has(thread)) return true;
    const mark = await this.saver.getTuple(threadOf(config, OUT_OF_ORDER));
    if (mark !== undefined) this.#marked.add(thread);
    return mark !== undefined;
  }

  /** Marks the thread before the checkpoint that would sort out of order is stored. */
  async #mark(config: RunnableConfig): Promise<void> {
    if (await this.#isMarked(config)) return;
    const at = threadOf(config, OUT_OF_ORDER);
    const metadata: CheckpointMetadata = { source: "update", step: -1, parents: {} };
    await this.saver.put(at, emptyCheckpoint(), metadata, {});
    this.#marked.add(threadIdOf(config));
  }

  /** A marked thread's checkpoints of `config`'s namespace (every one when unset), newest first. */
  async #ordered(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): Promise<CheckpointTuple[]> {
    const all: CheckpointTuple[] = [];
    for await (const tuple of this.saver.list(config, { ...options, limit: undefined }))
      if (namespaceOf(tuple.config) !== OUT_OF_ORDER) all.push(tuple);
    return all.sort(newestFirst);
  }
}

/** The namespace of a thread's mark: a checkpoint id of it sorted out of order once. */
export const OUT_OF_ORDER = "agboss-out-of-order";

/** Newest first: by LangGraph's step (each run continues at its last step + 1), then by id. */
const newestFirst = (first: CheckpointTuple, second: CheckpointTuple): number =>
  (second.metadata?.step ?? -2) - (first.metadata?.step ?? -2) ||
  second.checkpoint.id.localeCompare(first.checkpoint.id);

function* limited(tuples: readonly CheckpointTuple[], limit: number | undefined) {
  yield* limit === undefined ? tuples : tuples.slice(0, limit);
}

const idOf = (config: RunnableConfig): string | undefined => {
  const id: unknown = config.configurable?.checkpoint_id;
  return typeof id === "string" ? id : undefined;
};

const threadIdOf = (config: RunnableConfig): string => String(config.configurable?.thread_id);

const namespaceOf = (config: RunnableConfig | undefined): string =>
  String(config?.configurable?.checkpoint_ns ?? "");

const keyOf = (config: RunnableConfig): string =>
  `${threadIdOf(config)}\u0000${namespaceOf(config)}`;

const threadOf = (config: RunnableConfig, namespace: string): RunnableConfig => {
  const thread: unknown = config.configurable?.thread_id;
  return { configurable: { thread_id: thread, checkpoint_ns: namespace } };
};
