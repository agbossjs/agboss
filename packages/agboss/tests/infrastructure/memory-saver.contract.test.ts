/**
 * #511 AC2: LangGraph's own savers pass the published checkpoint saver contract as they are. The
 * contract's `put` passes the versions of the channels it changed, as LangGraph does; a saver that
 * writes a channel's value only for those versions — LangGraph's `PostgresSaver` keeps them as
 * blobs by `(channel, version)` — needs no wrapper writing every channel on each `put`.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MemorySaver,
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { describe } from "vitest";
import { isChildThreadOf } from "../../src/infrastructure/checkpoint-threads.js";
import { newestFirstOrder, stepOf } from "../../src/infrastructure/latest-by-step.js";
import { checkpointSaverContract, StoreCapability } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "./contracts/store-kinds.js";

/** The versions `put` is given (LangGraph's `ChannelVersions`, not re-exported by `@langchain/langgraph`). */
type ChannelVersions = Parameters<BaseCheckpointSaver["put"]>[3];

/**
 * LangGraph's `MemorySaver` with the one thing the contract asks beyond it (#1321d): `deleteThread`
 * of a tree's root also removes its child threads (`<root>/child/…`), as every saver of a store does.
 */
class ChildThreadsMemorySaver extends MemorySaver {
  override async deleteThread(threadId: string): Promise<void> {
    const threads = [...Object.keys(this.storage), ...Object.keys(this.writes).map(writerOf)];
    for (const each of new Set(threads)) {
      if (each === threadId || isChildThreadOf(threadId, each)) await super.deleteThread(each);
    }
  }
}

const writerOf = (key: string): string => String((JSON.parse(key) as unknown[])[0]);

/** Where a blob lives: thread, namespace, channel and the version it was written at. */
const blobKey = (config: RunnableConfig, channel: string, version: string | number): string =>
  JSON.stringify([
    config.configurable?.thread_id,
    config.configurable?.checkpoint_ns ?? "",
    channel,
    version,
  ]);

/**
 * A saver with `PostgresSaver`'s semantics on LangGraph's `MemorySaver`: a checkpoint is kept
 * without its values, and each value is written once, as a blob of the version `put` is given; a
 * read joins the checkpoint's `channel_versions` to the blobs. A channel `put` is not given a
 * version for has no value read back.
 */
class VersionedBlobSaver extends ChildThreadsMemorySaver {
  readonly #blobs = new Map<string, unknown>();

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions = {},
  ): Promise<RunnableConfig> {
    for (const [channel, version] of Object.entries(newVersions)) {
      if (channel in checkpoint.channel_values) {
        this.#blobs.set(blobKey(config, channel, version), checkpoint.channel_values[channel]);
      }
    }
    return super.put(config, { ...checkpoint, channel_values: {} }, metadata);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config);
    if (tuple === undefined) return undefined;
    const values: Record<string, unknown> = {};
    for (const [channel, version] of Object.entries(tuple.checkpoint.channel_versions)) {
      const key = blobKey(tuple.config, channel, version);
      if (this.#blobs.has(key)) values[channel] = this.#blobs.get(key);
    }
    return { ...tuple, checkpoint: { ...tuple.checkpoint, channel_values: values } };
  }
}

/** The same with `latestByStep` (#1037): the newest by step of the listed checkpoints, read as a blob join does. */
class VersionedBlobLatestSaver extends VersionedBlobSaver {
  async latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns } = config.configurable ?? {};
    const ranked: { id: string; step: number }[] = [];
    for await (const tuple of this.list({ configurable: { thread_id, checkpoint_ns } }))
      ranked.push({ id: tuple.checkpoint.id, step: stepOf(tuple.metadata) });
    const newest = ranked.sort(newestFirstOrder)[0];
    if (newest === undefined) return undefined;
    return this.getTuple({ configurable: { thread_id, checkpoint_ns, checkpoint_id: newest.id } });
  }
}

describe("#511 AC2: LangGraph's MemorySaver passes checkpointSaverContract", () => {
  checkpointSaverContract({
    ...inMemoryTarget((seam) =>
      sharedInMemory(seam, "memory-saver", () => new ChildThreadsMemorySaver()),
    ),
    name: "LangGraph MemorySaver",
  });
});

describe("#511 AC2: a saver that writes only the versions it is given passes, as PostgresSaver does", () => {
  checkpointSaverContract({
    ...inMemoryTarget((seam) =>
      sharedInMemory(seam, "versioned-blobs", () => new VersionedBlobSaver()),
    ),
    name: "versioned blobs",
  });
});

describe("#1037 AC1: the latestByStep cases are valid LangGraph checkpoints, with channel versions", () => {
  checkpointSaverContract({
    ...inMemoryTarget((seam) =>
      sharedInMemory(seam, "versioned-blobs-latest", () => new VersionedBlobLatestSaver()),
    ),
    name: "versioned blobs with latestByStep",
    capabilities: [StoreCapability.LatestByStep],
  });
});
