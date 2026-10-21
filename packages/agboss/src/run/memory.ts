import { memoryPlanOf } from "../compaction/plan.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { HistoryTurn } from "../flow/runtime/history.js";
import type { BaseMemoryStrategy, MemoryTurn, MemoryUpdate } from "../memory/types.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import type { Compacted, CompactionOutcome } from "./compaction.js";
import type { FinishContext } from "./execute.js";
import type { RunDeps } from "./types.js";

/** What updating memory after a turn did: its spend (already recorded) and the compactions, if any. */
export interface MemoryAfterTurn extends MemoryUpdate {
  readonly usage: readonly UsageRecord[];
  readonly compacted: readonly Compacted[];
}

/** The agents' own strategies (`@Agent({ memoryStrategy })`), each instance once. */
const agentStrategiesOf = <TName extends string>(deps: RunDeps<TName>): BaseMemoryStrategy[] => [
  ...new Set(deps.memory?.values() ?? []),
];

const NOTHING_COMPACTED: CompactionOutcome = { usage: [], compacted: [] };

/**
 * The workflow's compactions that write summaries (#120 PR 3), run after the turn — loaded on first
 * use (QUALITY.md: a runtime subsystem loads lazily), so a workflow without one never imports them.
 */
async function compactAfter<TName extends string>(
  ctx: FinishContext<TName>,
  turn: MemoryTurn,
  tokens: PiiTokenMap,
): Promise<CompactionOutcome> {
  const plan = memoryPlanOf(ctx.deps.config, ctx.deps.compactions);
  if (plan.compactions.length === 0) return NOTHING_COMPACTED;
  const { compactDue } = await import("./compaction.js");
  return compactDue(ctx.deps, plan, {
    tenantId: turn.tenantId,
    threadId: turn.threadId,
    budgetLeftUsd: turn.budgetLeftUsd,
    callbacks: ctx.callbacks,
    tokens,
    record: ctx.record,
  });
}

/**
 * After a finished turn: the workflow's compactions (their spend recorded call by call — a
 * `CompactionError` fails the execution with it counted), then every agent's own strategy updates
 * its memory (its spend counted in the execution's budgets).
 */
export async function updateMemoryAfter<TName extends string>(
  ctx: FinishContext<TName>,
  usageSoFar: readonly UsageRecord[],
  history: HistoryTurn,
  tokens: PiiTokenMap,
): Promise<MemoryAfterTurn> {
  const turn: MemoryTurn = {
    tenantId: ctx.base.tenantId,
    threadId: ctx.base.threadId,
    runId: ctx.runId,
    turn: history,
    budgetLeftUsd: ctx.budgetUsd - totalCost(usageSoFar),
  };
  const compactions = await compactAfter(ctx, turn, tokens);
  const usage: UsageRecord[] = [];
  for (const strategy of agentStrategiesOf(ctx.deps)) {
    const left = turn.budgetLeftUsd - totalCost(compactions.usage) - totalCost(usage);
    const update = await strategy.updateMemory?.({ ...turn, budgetLeftUsd: left });
    usage.push(...(update?.usage ?? []));
  }
  if (usage.length > 0) await ctx.record(usage);
  return { usage: [...compactions.usage, ...usage], compacted: compactions.compacted };
}
