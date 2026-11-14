import type { RunnableConfig } from "@langchain/core/runnables";
import {
  emptyCheckpoint,
  type BaseCheckpointSaver,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import {
  hasLatestByStep,
  newestFirstOrder,
  stepOf,
  type LatestByStepCheckpointSaver,
} from "../../infrastructure/latest-by-step.js";

/** What the `latestByStep` cases (#962) put, read back and compare with. */

export const at = (thread: string, namespace = ""): RunnableConfig => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
});

/** The store as the capability, failing the case when it has none (the capability gate ran first). */
export function capable(store: BaseCheckpointSaver): LatestByStepCheckpointSaver {
  if (!hasLatestByStep(store)) throw new Error("the store has no latestByStep");
  return store;
}

/** The metadata of a checkpoint; none for `undefined`: as an older writer left it. */
function withStep(step: number | undefined): CheckpointMetadata {
  const metadata: CheckpointMetadata = { source: "loop", step: step ?? 0, parents: {} };
  if (step === undefined) Reflect.deleteProperty(metadata, "step");
  return metadata;
}

/**
 * Puts checkpoint `id` at `step` of `thread`'s `namespace`, its marker a channel with a version of
 * its own (`id@step`): a valid LangGraph checkpoint, so a store that keeps a channel's value as a
 * blob of a version listed in `newVersions` (LangGraph's `PostgresSaver`) returns it too.
 */
export const put = (
  store: BaseCheckpointSaver,
  where: RunnableConfig,
  id: string,
  step: number | undefined,
): Promise<RunnableConfig> => {
  const marker = `${id}@${String(step)}`;
  return store.put(
    where,
    {
      ...emptyCheckpoint(),
      id,
      channel_values: { marker },
      channel_versions: { marker },
    },
    withStep(step),
    { marker },
  );
};

/** What the full scan answers: the newest by `(step, id)` of the namespace's listed checkpoints. */
export async function scanned(
  store: BaseCheckpointSaver,
  where: RunnableConfig,
): Promise<string | undefined> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of store.list(where)) tuples.push(tuple);
  const [newest] = tuples.sort((a, b) =>
    newestFirstOrder(
      { step: stepOf(a.metadata), id: a.checkpoint.id },
      { step: stepOf(b.metadata), id: b.checkpoint.id },
    ),
  );
  return newest?.checkpoint.id;
}

/** A small seeded generator: the same histories on every store and run. */
export function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export const IDS = ["a", "b", "B", "Z", "a-1", "a-2", "0f", "zz", "A-1", "m"];
