import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";

/**
 * An optional capability of a checkpoint saver (#962): its checkpoint of one thread and namespace
 * that is newest by LangGraph's step, an indexed read — not a list sorted in memory.
 */
export interface LatestByStepCheckpointSaver extends BaseCheckpointSaver {
  /**
   * The checkpoint of `config`'s `thread_id` and `checkpoint_ns` (`""` when unset) with the greatest
   * `metadata.step`, ties by the greatest `checkpoint_id` (compared by code unit); `config`'s
   * `checkpoint_id` is ignored. A checkpoint whose step is missing or not a number counts as
   * {@link NO_STEP}. Read as `getTuple` reads it; `undefined` for a thread or namespace without one.
   * The step is written in the same write as the checkpoint, so the answer is never a stale or a
   * half-written checkpoint.
   */
  latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined>;
}

/** The step of a checkpoint whose metadata has none (or none that is a number). */
export const NO_STEP = -2;

/** The step `checkpoint metadata` orders by: `metadata.step` when a finite number, else {@link NO_STEP}. */
export function stepOf(metadata: { readonly step?: unknown } | undefined): number {
  const step = metadata?.step;
  return typeof step === "number" && Number.isFinite(step) ? step : NO_STEP;
}

/** Whether `saver` can read a thread's newest checkpoint by an index (#962). */
export const hasLatestByStep = (saver: BaseCheckpointSaver): saver is LatestByStepCheckpointSaver =>
  "latestByStep" in saver && typeof saver.latestByStep === "function";

/** A sort comparator, newest first: negative when `first` is newer by step, then by id (code units). */
export const newestFirstOrder = (
  first: { readonly step: number; readonly id: string },
  second: { readonly step: number; readonly id: string },
): number =>
  second.step - first.step || (second.id === first.id ? 0 : second.id < first.id ? -1 : 1);
