import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph";
import { newestFirstOrder, stepOf } from "../infrastructure/latest-by-step.js";

/** What `OrderedCheckpointSaver` reads of a config, and the order of a marked thread (#682, #962). */

/** The namespace of a thread's mark: a checkpoint id of it sorted out of order once. */
export const OUT_OF_ORDER = "agboss-out-of-order";

/**
 * Newest first: by LangGraph's step (each run continues at its last step + 1; none or not a number
 * counts as -2), then by id by code unit — the order `latestByStep` reads (#962).
 */
export const newestFirst = (first: CheckpointTuple, second: CheckpointTuple): number =>
  newestFirstOrder(
    { step: stepOf(first.metadata), id: first.checkpoint.id },
    { step: stepOf(second.metadata), id: second.checkpoint.id },
  );

export function* limited(tuples: readonly CheckpointTuple[], limit: number | undefined) {
  yield* limit === undefined ? tuples : tuples.slice(0, limit);
}

export const idOf = (config: RunnableConfig): string | undefined => {
  const id: unknown = config.configurable?.checkpoint_id;
  return typeof id === "string" ? id : undefined;
};

export const threadIdOf = (config: RunnableConfig): string =>
  String(config.configurable?.thread_id);

export const namespaceOf = (config: RunnableConfig | undefined): string =>
  String(config?.configurable?.checkpoint_ns ?? "");

export const keyOf = (config: RunnableConfig): string =>
  `${threadIdOf(config)}\u0000${namespaceOf(config)}`;

export const threadOf = (config: RunnableConfig, namespace: string): RunnableConfig => {
  const thread: unknown = config.configurable?.thread_id;
  return { configurable: { thread_id: thread, checkpoint_ns: namespace } };
};
