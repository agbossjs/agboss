import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { memoryPlanOf } from "../compaction/plan.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { HistoryTurn } from "../flow/runtime/history.js";
import type { BaseMemoryStrategy, MemoryTurn, MemoryUpdate } from "../memory/types.js";
import type { Compacted, CompactionOutcome } from "./compaction.js";
import type { FinishContext } from "./execute.js";
import { NO_THREAD_MEMORY, threadMemoryOf, type ThreadMemory } from "./thread.js";
import type { AgentExecutionDeps } from "./types.js";

/** What updating memory after a turn did: its spend, already recorded. */
export interface MemoryAfterTurn extends MemoryUpdate {
  readonly usage: readonly UsageRecord[];
}

/** The agents' own strategies (`@Agent({ memoryStrategy })`), each instance once. */
const agentStrategiesOf = <TName extends string>(
  deps: AgentExecutionDeps<TName>,
): BaseMemoryStrategy[] => [...new Set(deps.memory?.values() ?? [])];

const NOTHING_COMPACTED: CompactionOutcome = { usage: [], compacted: [] };

/** The thread a new execution reads, and what it may spend on compacting it. */
export interface MemoryBeforeRun {
  readonly tenantId: string;
  readonly threadId: string;
  /** A thread this execution just created: nothing to compact, nothing to read. */
  readonly isNewThread: boolean;
  readonly budgetLeftUsd: number;
  readonly callbacks: BaseCallbackHandler[];
  readonly record: (records: readonly UsageRecord[]) => Promise<void>;
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
  const plan = memoryPlanOf(deps.config, deps.compactions);
  const thread = { tenantId: run.tenantId, threadId: run.threadId };
  const compacted =
    plan.compactions.length === 0
      ? NOTHING_COMPACTED
      : await (await import("./compaction.js")).compactDue(deps, plan, { ...run, tokens: {} });
  return { ...(await threadMemoryOf(deps, thread)), ...compacted };
}

/**
 * After a finished turn: every agent's own strategy updates its memory (its spend counted in the
 * execution's budgets). The compactions run before the next turn, never here (#120 S132).
 */
export async function updateMemoryAfter<TName extends string>(
  ctx: FinishContext<TName>,
  usageSoFar: readonly UsageRecord[],
  history: HistoryTurn,
): Promise<MemoryAfterTurn> {
  const turn: MemoryTurn = {
    tenantId: ctx.base.tenantId,
    threadId: ctx.base.threadId,
    executionId: ctx.runId,
    turn: history,
    budgetLeftUsd: ctx.budgetUsd - totalCost(usageSoFar),
  };
  const usage: UsageRecord[] = [];
  for (const strategy of agentStrategiesOf(ctx.deps)) {
    const left = turn.budgetLeftUsd - totalCost(usage);
    const update = await strategy.updateMemory?.({ ...turn, budgetLeftUsd: left });
    usage.push(...(update?.usage ?? []));
  }
  if (usage.length > 0) await ctx.record(usage);
  return { usage };
}
