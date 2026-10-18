import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { HistoryTurn } from "../flow/runtime/history.js";
import { SlidingWindowStrategy } from "../memory/sliding-window.js";
import type { BaseMemoryStrategy, MemoryTurn, MemoryUpdate } from "../memory/types.js";
import { compactIfDue, type Compacted } from "./compaction.js";
import type { FinishContext } from "./execute.js";
import type { RunDeps } from "./types.js";

/** What updating memory after a turn did: its spend (already recorded) and the compaction, if any. */
export interface MemoryAfterTurn extends MemoryUpdate {
  readonly usage: readonly UsageRecord[];
  readonly compacted?: Compacted;
}

/**
 * The built-in strategy of a workflow with `compaction`: agents see the sliding window over the
 * summaries and the turns not yet compacted; after a turn, every `every` uncompacted turns become one
 * summary written by the compaction model (through the model gateway, spend counted in the execution's budgets).
 */
export class CompactionStrategy<TName extends string> extends SlidingWindowStrategy {
  constructor(
    private readonly deps: RunDeps<TName>,
    private readonly callbacks: BaseCallbackHandler[],
  ) {
    super();
  }

  override updateMemory(turn: MemoryTurn): Promise<MemoryAfterTurn> {
    return compactIfDue(this.deps, {
      threadId: turn.threadId,
      budgetLeftUsd: turn.budgetLeftUsd,
      callbacks: this.callbacks,
    });
  }
}

/** The agents' own strategies (`@Agent({ memoryStrategy })`), each instance once. */
const agentStrategiesOf = <TName extends string>(deps: RunDeps<TName>): BaseMemoryStrategy[] => [
  ...new Set(deps.memory?.values() ?? []),
];

/**
 * After a finished turn: the workflow's built-in strategy (compaction, when configured), then every
 * agent's own strategy update the memory; their spend is counted in the execution's budgets.
 */
export async function updateMemoryAfter<TName extends string>(
  ctx: FinishContext<TName>,
  usageSoFar: readonly UsageRecord[],
  history: HistoryTurn,
): Promise<MemoryAfterTurn> {
  const turn: MemoryTurn = {
    threadId: ctx.base.threadId,
    runId: ctx.runId,
    turn: history,
    budgetLeftUsd: ctx.budgetUsd - totalCost(usageSoFar),
  };
  const builtIn =
    ctx.deps.config.compaction === undefined
      ? { usage: [] }
      : await new CompactionStrategy(ctx.deps, ctx.callbacks).updateMemory(turn);
  const usage = [...builtIn.usage];
  for (const strategy of agentStrategiesOf(ctx.deps)) {
    const left = turn.budgetLeftUsd - totalCost(usage);
    const update = await strategy.updateMemory?.({ ...turn, budgetLeftUsd: left });
    usage.push(...(update?.usage ?? []));
  }
  if (usage.length > 0) await ctx.record(usage);
  return builtIn.compacted === undefined ? { usage } : { usage, compacted: builtIn.compacted };
}
