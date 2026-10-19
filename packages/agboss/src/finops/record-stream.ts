import type { UsageRecord } from "./usage.js";

export class EmptyRunError extends Error {
  override name = "EmptyRunError";
}

/** Anything that carries the run's usage records so far (the graph state does). */
export interface HasUsage {
  readonly usage: readonly UsageRecord[];
}

/**
 * A usage record as a multiset key, by its fields (never by how an object was built: a record read
 * back from a checkpoint may list them in another order): two equal records are the same spend.
 */
const keyOf = (record: UsageRecord): string =>
  JSON.stringify([
    record.caller,
    record.model,
    record.costUsd,
    record.costSource,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
  ]);

/**
 * The records of `usage` not in `recorded`, as multisets: the first `n` equal records are the ones
 * already recorded. Order does not matter — the branches of a parallel launch (and the loops paused
 * in them, #267) add theirs in any order, so a position says nothing about what is in the ledger.
 */
export function unrecordedOf(
  usage: readonly UsageRecord[],
  recorded: readonly UsageRecord[],
): readonly UsageRecord[] {
  const left = new Map<string, number>();
  for (const record of recorded) left.set(keyOf(record), (left.get(keyOf(record)) ?? 0) + 1);
  return usage.filter((record) => {
    const count = left.get(keyOf(record)) ?? 0;
    if (count === 0) return true;
    left.set(keyOf(record), count - 1);
    return false;
  });
}

/**
 * Drains a stream of full states, handing every new usage record to `record` as soon as it
 * appears — new: not among `alreadyRecorded` and what this drain recorded — and returns the last
 * state. Spend is persisted even if the run fails midway.
 */
export async function drainRecordingUsage<TState extends HasUsage>(
  states: AsyncIterable<TState>,
  record: (records: readonly UsageRecord[]) => Promise<void>,
  alreadyRecorded: readonly UsageRecord[] = [],
): Promise<TState> {
  let last: TState | undefined;
  const recorded = [...alreadyRecorded];
  for await (const state of states) {
    // a resumed run's first states may hold less than what is already recorded
    const fresh = unrecordedOf(state.usage, recorded);
    await record(fresh);
    recorded.push(...fresh);
    last = state;
  }
  if (last === undefined) throw new EmptyRunError("The run produced no state");
  return last;
}
