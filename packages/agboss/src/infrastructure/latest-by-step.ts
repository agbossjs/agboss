import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";

/**
 * An optional capability of a checkpoint saver (#962): its checkpoint of one thread and namespace
 * that is newest by LangGraph's step, an indexed read — not a list sorted in memory.
 */
export interface LatestByStepCheckpointSaver extends BaseCheckpointSaver {
  /**
   * The checkpoint of `config`'s `thread_id` and `checkpoint_ns` (`""` when unset) with the greatest
   * `metadata.step`, ties by the greatest `checkpoint_id` (compared by code point: UTF-8 byte order, SQLite's BINARY and
   * PostgreSQL's `COLLATE "C"`, MongoDB's string order; not UTF-16 code unit order, where a character above
   * U+FFFF sorts below U+E000..U+FFFF, #1115); `config`'s
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

/**
 * Text order by code point, as a SQL store's byte order compares (#1115). JavaScript's `<` compares
 * UTF-16 code units, which puts a surrogate pair (U+10000 and above) below U+E000..U+FFFF.
 * A unit from U+D800 up is shifted so surrogates, which stand for the astral planes, sort above them.
 */
export function compareCodePoints(first: string, second: string): number {
  if (first === second) return 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const left = first.charCodeAt(index);
    const right = second.charCodeAt(index);
    if (left !== right) return rankOf(left) - rankOf(right);
  }
  return first.length - second.length;
}

const SURROGATES = 0xd800;
const BEYOND_SURROGATES = 0xe000;
const SURROGATE_SPAN = 0x800;
const rankOf = (unit: number): number =>
  unit < SURROGATES ? unit : unit < BEYOND_SURROGATES ? unit + 0x2000 : unit - SURROGATE_SPAN;

/** A sort comparator, newest first: negative when `first` is newer by step, then by id (code points). */
export const newestFirstOrder = (
  first: { readonly step: number; readonly id: string },
  second: { readonly step: number; readonly id: string },
): number => second.step - first.step || compareCodePoints(second.id, first.id);
