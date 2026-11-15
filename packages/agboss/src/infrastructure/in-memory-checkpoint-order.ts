import type { MemorySaver, CheckpointTuple } from "@langchain/langgraph";
import { compareCodePoints } from "./latest-by-step.js";

export type CheckpointListOptions = NonNullable<Parameters<MemorySaver["list"]>[1]>;

const idOf = (tuple: CheckpointTuple): string => String(tuple.config.configurable?.checkpoint_id);

/**
 * `tuples` (every checkpoint `MemorySaver.list` found, unlimited) with each thread's and namespace's
 * checkpoints newest first by code point, as the stores order them (#1115, #1143); `MemorySaver`
 * sorts ids by UTF-16 code unit, which puts an astral id below U+E000..U+FFFF. `before` and `limit`
 * apply to that order.
 */
export async function* newestFirstByCodePoint(
  tuples: AsyncIterable<CheckpointTuple>,
  options: CheckpointListOptions | undefined,
): AsyncGenerator<CheckpointTuple> {
  const groups = new Map<string, CheckpointTuple[]>();
  for await (const tuple of tuples) {
    const { thread_id: thread, checkpoint_ns: namespace } = tuple.config.configurable ?? {};
    const key = `${String(thread)}\u0000${String(namespace)}`;
    groups.set(key, [...(groups.get(key) ?? []), tuple]);
  }
  const before = options?.before?.configurable?.checkpoint_id as string | undefined;
  const ordered = [...groups.values()]
    .flatMap((group) => group.sort((a, b) => compareCodePoints(idOf(b), idOf(a))))
    .filter((tuple) => before === undefined || compareCodePoints(idOf(tuple), before) < 0);
  yield* ordered.slice(0, Math.max(0, options?.limit ?? ordered.length));
}
