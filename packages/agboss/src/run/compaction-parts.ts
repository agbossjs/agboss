import type { UsageRecord } from "../finops/usage.js";
import { DetectionMode } from "../pii/runtime-policy.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import type { Summary, Tern } from "../terns/index.js";
import type { Compacted, CompactionRun } from "./compaction.js";
import type { AgentExecutionDeps } from "./types.js";

/**
 * What both kinds of compaction share at run time (#120 PR 3, #382): what they read goes through the
 * application's and the workflow's PII policies (S84 i), and what they wrote is stored as one
 * summary of the thread from its first summarised record (a queue: from the first record due).
 */

/** A text through the policies, the tokens known after it and what masking it cost. */
export interface MaskedText {
  readonly text: string;
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/** One text through the application's and the workflow's PII policies, with its new tokens. */
export async function maskedTextOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  text: string,
  run: Pick<CompactionRun, "record">,
  tokens: PiiTokenMap,
): Promise<MaskedText> {
  const policies = deps.pii?.workflowPolicies;
  if (policies === undefined || policies.isEmpty) return { text, tokens, usage: [] };
  const { masked, usage } = await policies.mask(text, tokens, DetectionMode.WithModel);
  await run.record(usage);
  // a blocked value is shown as `<kind>`: the turn itself was already accepted by its readers
  return { text: masked.text, tokens: { ...tokens, ...masked.tokens }, usage };
}

/** What one compaction wrote, to store: the records it covers, its text and its cost. */
export interface CompactionWrite {
  readonly compaction: string;
  readonly due: readonly Tern[];
  /** The summary it rewrites (a single summary, a custom one): it covers the thread from its start. */
  readonly current?: Summary | undefined;
  readonly text: string;
  readonly costUsd: number;
  /** The summaries readers see now, and how many they may see. */
  readonly summaries: number;
  readonly summaryQueueLength: number;
}

/** Stores what one compaction wrote and says what it did. */
export async function storedCompaction<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: Pick<CompactionRun, "tenantId" | "threadId">,
  write: CompactionWrite,
): Promise<Compacted | undefined> {
  const [first] = write.due;
  const last = write.due.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const { tenantId, threadId } = run;
  await deps.terns.addSummary({
    tenantId,
    threadId,
    bundle: deps.config.name,
    compaction: write.compaction,
    fromTernId: write.current?.fromTernId ?? first.id,
    toTernId: last.id,
    turns: (write.current?.turns ?? 0) + write.due.length,
    text: write.text,
    costUsd: write.costUsd,
  });
  return {
    compaction: write.compaction,
    fromTurn: await deps.terns.turnNumber(tenantId, threadId, first.id),
    toTurn: await deps.terns.turnNumber(tenantId, threadId, last.id),
    summaries: write.summaries,
    summaryQueueLength: write.summaryQueueLength,
  };
}
