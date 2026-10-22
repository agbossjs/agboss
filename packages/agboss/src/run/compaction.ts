import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { CompactionError } from "../compaction/errors.js";
import { CompactionStrategy } from "../compaction/compaction.decorator.js";
import { TurnLimit } from "../config/types.js";
import type { CompactionInUse, ModelCompactionInUse, MemoryPlan } from "../compaction/plan.js";
import { recordUsage, totalCost, type UsageRecord } from "../finops/usage.js";
import type { ModelBinding } from "../llm/registry.js";
import { isCutAtLimit } from "../models/finish-reason.js";
import { revealedText, type PiiTokenMap } from "../pii/tokens.js";
import {
  CURRENT_SUMMARY_HEADING,
  EARLIER_TURNS_HEADING,
  SHORTER_SUMMARY_REQUEST,
  TURNS_TO_ADD_HEADING,
  TURNS_TO_COMPACT_HEADING,
} from "../prompts/compaction.js";
import type { Summary, Tern } from "../terns/index.js";
import { maskedTextOf, storedCompaction } from "./compaction-parts.js";
import { compactWithHandler } from "./custom-compaction.js";
import { isTurn, toTurns } from "./thread.js";
import type { AgentExecutionDeps } from "./types.js";

/**
 * Compaction at run time (#120 PR 3), loaded on first use — only a workflow whose readers use a
 * compaction that writes summaries reaches it. Lazily, before a new execution's first read of its
 * thread (S132), each such compaction summarises the records of the thread older than its window
 * (the smallest `uncompactedTurns` among its readers) once `turnsBetweenCompactions` of them have
 * gathered — so a finished turn's answer is always kept and a thread that ends pays for none. Its model reads the turns through
 * the application's and the workflow's PII policies (S84 i: masked like any model input); the
 * summary is revealed before it is stored, so the store and the readers hold real values and each
 * reader's own policies mask it at its boundary. A summary cut at `summaryMaxTokens` is asked once
 * more, shorter; cut again — or a failed call — is `CompactionError`.
 */

/** What one compaction did before the execution: the turns it summarised and its summaries now. */
export interface Compacted {
  /** The `@Compaction`'s name. */
  readonly compaction: string;
  /** 1-based positions of the first and the last record summarised. */
  readonly fromTurn: number;
  readonly toTurn: number;
  /** Its summaries readers see now (at most `summaryQueueLength`). */
  readonly summaries: number;
  readonly summaryQueueLength: number;
}

/** The thread compacted and what it may spend; every model call's spend is recorded at once. */
export interface CompactionRun {
  readonly tenantId: string;
  readonly threadId: string;
  readonly budgetLeftUsd: number;
  readonly callbacks: BaseCallbackHandler[];
  /** The execution's PII tokens: a value already tokenised keeps its token. */
  readonly tokens: PiiTokenMap;
  /** Runs work in the frame of the execution's start: a custom compaction's `ExecutionContext` (#382). */
  readonly inFrame: <T>(work: () => Promise<T>) => Promise<T>;
  readonly record: (records: readonly UsageRecord[]) => Promise<void>;
}

/** What compacting before an execution spent (already recorded) and did. */
export interface CompactionOutcome {
  readonly usage: readonly UsageRecord[];
  readonly compacted: readonly Compacted[];
}

const asTurns = (terns: readonly Tern[]): string =>
  toTurns(terns)
    .map((turn) => `${turn.start}\n${turn.finish}`)
    .join("\n\n");

const callerOf = (compaction: ModelCompactionInUse): string => `compaction:${compaction.name}`;

/**
 * The turns due: those older than the window, once `turnsBetweenCompactions` have gathered —
 * counted in turns (a failed or paused record is none, S8), as a reader's window is.
 */
function dueOf(
  compaction: Pick<CompactionInUse, "window" | "turnsBetweenCompactions">,
  records: readonly Tern[],
): readonly Tern[] {
  if (compaction.window === TurnLimit.ALL) return [];
  const uncovered = records.filter(isTurn);
  const due = uncovered.slice(0, Math.max(0, uncovered.length - compaction.window));
  return due.length < compaction.turnsBetweenCompactions ? [] : due;
}

/** What the compaction's model reads, in full (before masking). */
async function inputOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  compaction: ModelCompactionInUse,
  run: CompactionRun,
  due: readonly Tern[],
): Promise<{ readonly text: string; readonly current?: Summary }> {
  const [first] = due;
  const { tenantId, threadId } = run;
  if (compaction.strategy === CompactionStrategy.SingleSummary) {
    const [current] = await deps.terns.latestSummaries(tenantId, threadId, compaction.name, 1);
    const summary = current === undefined ? "(none yet)" : current.text;
    const text = `${CURRENT_SUMMARY_HEADING}\n${summary}\n\n${TURNS_TO_ADD_HEADING}\n${asTurns(due)}`;
    return current === undefined ? { text } : { text, current };
  }
  const previous =
    first === undefined
      ? []
      : await deps.terns.before(tenantId, threadId, first.id, compaction.turnsBetweenCompactions);
  const context = asTurns(previous);
  return {
    text:
      (context === "" ? "" : `${EARLIER_TURNS_HEADING}\n${context}\n\n`) +
      `${TURNS_TO_COMPACT_HEADING}\n${asTurns(due)}`,
  };
}

/** One call of the compaction's model; its spend recorded at once, a failure a `CompactionError`. */
async function summaryCall(
  binding: ModelBinding,
  compaction: ModelCompactionInUse,
  input: string,
  run: CompactionRun,
): Promise<{ readonly answer: AIMessage; readonly usage: UsageRecord }> {
  try {
    const answer = await binding.model.invoke(
      [new SystemMessage(compaction.prompt), new HumanMessage(input)],
      { callbacks: run.callbacks, runName: callerOf(compaction) },
    );
    const usage = recordUsage(callerOf(compaction), binding.settings, answer);
    await run.record([usage]);
    return { answer, usage };
  } catch (error) {
    if (error instanceof CompactionError) throw error;
    const message = `${compaction.name}: the summary's model call failed`;
    throw new CompactionError(message, compaction.name, compaction.summaryMaxTokens, error);
  }
}

/** The summary: the first answer, or — cut at `summaryMaxTokens` — the one asked to be shorter. */
async function summaryOf(
  binding: ModelBinding,
  compaction: ModelCompactionInUse,
  input: string,
  run: CompactionRun,
): Promise<{ readonly text: string; readonly usage: readonly UsageRecord[] }> {
  const first = await summaryCall(binding, compaction, input, run);
  if (!isCutAtLimit(first.answer)) return { text: first.answer.text, usage: [first.usage] };
  const shorter = await summaryCall(
    binding,
    compaction,
    `${input}\n\n${SHORTER_SUMMARY_REQUEST}`,
    run,
  );
  if (isCutAtLimit(shorter.answer)) {
    throw new CompactionError(
      `${compaction.name}: the summary did not fit in summaryMaxTokens ${String(compaction.summaryMaxTokens)}, also when asked to be shorter`,
      compaction.name,
      compaction.summaryMaxTokens,
    );
  }
  return { text: shorter.answer.text, usage: [first.usage, shorter.usage] };
}

/** A model's compaction of the records due: its summary written, revealed and stored. */
async function compactWithModel<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  compaction: ModelCompactionInUse,
  run: CompactionRun,
  due: readonly Tern[],
): Promise<CompactedOne> {
  const binding = deps.registry.compactions.get(compaction.name);
  if (binding === undefined) return { usage: [] };
  const input = await inputOf(deps, compaction, run, due);
  const masked = await maskedTextOf(deps, input.text, run, run.tokens);
  const summary = await summaryOf(binding, compaction, masked.text, run);
  const text = revealedText(summary.text.trim(), masked.tokens).text;
  if (text === "") {
    const message = `${compaction.name}: the model wrote an empty summary`;
    throw new CompactionError(message, compaction.name, compaction.summaryMaxTokens);
  }
  const { tenantId, threadId } = run;
  const count = (await deps.terns.summaryCount(tenantId, threadId, compaction.name)) + 1;
  const compacted = await storedCompaction(deps, run, {
    compaction: compaction.name,
    due,
    // a single summary covers the thread from its first summarised record
    current: input.current,
    text,
    costUsd: totalCost(summary.usage),
    summaries: Math.min(count, compaction.summaryQueueLength),
    summaryQueueLength: compaction.summaryQueueLength,
  });
  const usage = [...masked.usage, ...summary.usage];
  return compacted === undefined ? { usage } : { usage, compacted };
}

/** What one compaction did before the execution: its spend, and what it compacted (none: nothing due). */
export interface CompactedOne {
  readonly usage: readonly UsageRecord[];
  readonly compacted?: Compacted;
}

/** One compaction before the execution: nothing when nothing is due. */
async function compactOne<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  compaction: CompactionInUse,
  run: CompactionRun,
): Promise<CompactedOne> {
  const { tenantId, threadId } = run;
  const due = dueOf(compaction, await deps.terns.uncovered(tenantId, threadId, compaction.name));
  if (due.length === 0) return { usage: [] };
  return compaction.strategy === CompactionStrategy.Custom
    ? compactWithHandler(deps, compaction, run, due)
    : compactWithModel(deps, compaction, run, due);
}

/**
 * Before a new execution reads its thread: every compaction of the plan that writes summaries, in
 * order, while the execution's budget lasts (one with nothing left is skipped — the next compacts).
 */
export async function compactDue<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  plan: MemoryPlan,
  run: CompactionRun,
): Promise<CompactionOutcome> {
  const usage: UsageRecord[] = [];
  const compacted: Compacted[] = [];
  for (const compaction of plan.compactions) {
    if (run.budgetLeftUsd - totalCost(usage) <= 0) break;
    const one = await compactOne(deps, compaction, run);
    usage.push(...one.usage);
    if (one.compacted !== undefined) compacted.push(one.compacted);
  }
  return { usage, compacted };
}
