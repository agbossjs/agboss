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
import { checkpointSaverContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory } from "./contracts/store-kinds.js";

/** The versions `put` is given (LangGraph's `ChannelVersions`, not re-exported by `@langchain/langgraph`). */
type ChannelVersions = Parameters<BaseCheckpointSaver["put"]>[3];

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
class VersionedBlobSaver extends MemorySaver {
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

describe("#511 AC2: LangGraph's MemorySaver passes checkpointSaverContract", () => {
  checkpointSaverContract({
    ...inMemoryTarget((seam) => sharedInMemory(seam, "memory-saver", () => new MemorySaver())),
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
