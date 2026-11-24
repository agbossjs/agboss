import { currentFrame } from "../flow/context/frame.js";
import { executionEventOf, type ExecutionEvent } from "../flow/observers/execution-event.js";
import { totalCost } from "../finops/usage.js";
import { memoryError } from "../memory/memory-error.js";
import type { CompactedOne, CompactionRun } from "./compaction.js";
import type { AgentExecutionDeps } from "./types.js";

/** What an event takes when nothing observes (never read). */
const UNOBSERVED = {} as ExecutionEvent;

/** The execution part of a compaction's events, read in the frame of the execution's start. */
async function executionEventIn<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: CompactionRun,
  memory: string,
): Promise<ExecutionEvent> {
  if (deps.observer === undefined) return UNOBSERVED;
  const facts = await run.inFrame(() => Promise.resolve(currentFrame()?.execution));
  if (facts === undefined)
    throw memoryError({
      message: `${memory}: a compaction runs in the frame of its execution's start`,
      memory,
      summaryMaxTokens: undefined,
    });
  return executionEventOf(facts);
}

/** One compaction between `onCompactionStart` and `onCompactionEnd` (#1303): the end names what it spent. */
export async function observedCompaction<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: CompactionRun,
  about: { readonly memory: string; readonly turns: number },
  compact: () => Promise<CompactedOne>,
): Promise<CompactedOne> {
  const event = await executionEventIn(deps, run, about.memory);
  await deps.observer?.onCompactionStart({ ...event, ...about });
  const one = await compact();
  await deps.observer?.onCompactionEnd({
    ...event,
    ...about,
    costUsd: totalCost(one.usage),
    summaries: one.compacted?.summaries ?? 0,
  });
  return one;
}
