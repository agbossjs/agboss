import { budgetLeftOf } from "../finops/cost-report.js";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { memoryPlanOf } from "../memory/plan.js";
import type { UsageRecord } from "../finops/usage.js";
import type { Compacted, CompactionOutcome } from "./compaction.js";
import { NO_THREAD_MEMORY, threadMemoryOf, type ThreadMemory } from "./thread.js";
import type { AgentExecutionDeps } from "./types.js";
import { lazyLoad } from "../infrastructure/clock.js";

const NOTHING_COMPACTED: CompactionOutcome = { usage: [], compacted: [] };

/** The thread a new execution reads, and what it may spend on compacting it. */
export interface MemoryBeforeRun {
  readonly tenantId: string;
  readonly threadId: string;
  /** A thread this execution just created: nothing to compact, nothing to read. */
  readonly isNewThread: boolean;
  /** What the execution may spend in all, `Infinity` without a cost limit: what compacting may use. */
  readonly budgetUsd: number;
  readonly callbacks: BaseCallbackHandler[];
  readonly record: (records: readonly UsageRecord[]) => Promise<void>;
  /** Runs work in the frame of the execution's start (a custom compaction's `compact()`, #382). */
  readonly inFrame: <T>(work: () => Promise<T>) => Promise<T>;
}

/** The thread's memory for the execution, after its compactions, and what they spent and did. */
export interface MemoryOfRun extends ThreadMemory {
  readonly usage: readonly UsageRecord[];
  readonly compacted: readonly Compacted[];
}

/**
 * Before a new execution's first read of its thread (#120 S132): the compactions due run first —
 * lazily, so a thread that ends never pays for one after its last turn, and a finished turn's answer
 * is always kept. Their spend is recorded call by call; a `CompactionError` fails the new execution
 * before any of its work (no model call of its own, no step, no turn kept). The compaction runtime
 * loads on first use (QUALITY.md: a runtime subsystem loads lazily).
 */
export async function memoryBeforeRun<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: MemoryBeforeRun,
): Promise<MemoryOfRun> {
  if (run.isNewThread) return { ...NO_THREAD_MEMORY, ...NOTHING_COMPACTED };
  const plan = memoryPlanOf(deps.config, deps.memories);
  const thread = { tenantId: run.tenantId, threadId: run.threadId };
  const compacted =
    plan.compactions.length === 0
      ? NOTHING_COMPACTED
      : await (
          await lazyLoad(import("./compaction.js"))
        ).compactDue(deps, plan, {
          ...run,
          budgetLeftUsd: budgetLeftOf(run.budgetUsd),
          tokens: {},
        });
  return { ...(await threadMemoryOf(deps, thread)), ...compacted };
}
