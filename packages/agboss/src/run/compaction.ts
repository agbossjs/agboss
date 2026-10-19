import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { recordUsage, totalCost, type UsageRecord } from "../finops/usage.js";
import { DEFAULT_COMPACTION_PROMPT } from "../prompts/compaction.js";
import type { Tern } from "../terns/index.js";
import type { RunDeps } from "./types.js";

/** What the last turn compacted: turns `fromTurn`–`toTurn` of the thread into one summary. */
export interface Compacted {
  readonly fromTurn: number;
  readonly toTurn: number;
  /** Summaries in context now (≤ keep). */
  readonly summaries: number;
  readonly keep: number;
}

const asTurns = (terns: readonly Tern[]): string =>
  terns.map((t) => `${t.task}\n${t.replyWith}`).join("\n\n");

const compactionInput = (previous: readonly Tern[], window: readonly Tern[]): string =>
  (previous.length === 0 ? "" : `Earlier turns (context only):\n${asTurns(previous)}\n\n`) +
  `Turns to compact:\n${asTurns(window)}`;

export interface CompactionRun {
  /** The thread: its tenant and its id (#261 S72). */
  readonly tenantId: string;
  readonly threadId: string;
  readonly budgetLeftUsd: number;
  readonly callbacks: BaseCallbackHandler[];
}

/**
 * After a finished turn: when the thread has ≥ `every` turns not yet summarised, the oldest `every`
 * become one self-contained summary (the previous raw window is read-only context; summaries never
 * read summaries). Never throws — a failure leaves the turns raw for the next turn to retry.
 */
export async function compactIfDue<TName extends string>(
  deps: RunDeps<TName>,
  run: CompactionRun,
): Promise<{ readonly usage: UsageRecord[]; readonly compacted?: Compacted }> {
  const settings = deps.config.compaction;
  const model = deps.registry.compaction;
  const usage: UsageRecord[] = [];
  if (settings === undefined || model === undefined || run.budgetLeftUsd <= 0) return { usage };
  try {
    const { tenantId, threadId } = run;
    const window = (await deps.terns.uncovered(tenantId, threadId)).slice(0, settings.every);
    const [first] = window;
    const last = window.at(-1);
    if (window.length < settings.every || first === undefined || last === undefined)
      return { usage };
    const previous = await deps.terns.before(tenantId, threadId, first.id, settings.every);
    const response = await model.model.invoke(
      [
        new SystemMessage(deps.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT),
        new HumanMessage(compactionInput(previous, window)),
      ],
      { callbacks: run.callbacks, runName: "compaction" },
    );
    usage.push(recordUsage("compaction", model.settings, response));
    const text = response.text.trim();
    if (text === "") return { usage };
    await deps.terns.addSummary({
      tenantId,
      threadId,
      bundle: deps.config.name,
      fromTernId: first.id,
      toTernId: last.id,
      turns: window.length,
      text,
      costUsd: totalCost(usage),
    });
    const count = await deps.terns.summaryCount(tenantId, threadId);
    return {
      usage,
      compacted: {
        fromTurn: await deps.terns.turnNumber(tenantId, threadId, first.id),
        toTurn: await deps.terns.turnNumber(tenantId, threadId, last.id),
        summaries: Math.min(count, settings.keep),
        keep: settings.keep,
      },
    };
  } catch {
    return { usage };
  }
}
