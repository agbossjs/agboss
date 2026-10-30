import type { Price, ResolvedModelSettings } from "../config/types.js";
import { fallbackMarkOf } from "./fallback-mark.js";
import { servedByOf } from "./served-by.js";

/** Anything a chat model returns that may carry token usage (AIMessage, AIMessageChunk). */
export interface UsageCarrier {
  /** The provider's raw replyWith metadata; OpenRouter's `usage.cost` is the call's cost in USD. */
  readonly response_metadata?: Readonly<Record<string, unknown>>;
  readonly usage_metadata?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly input_token_details?: {
      readonly cache_read?: number;
      readonly cache_creation?: number;
    };
  };
}

/** inputTokens includes cached tokens (OpenAI-compatible accounting). */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * "api" = cost reported by the provider (exact); "price-table" = tokens × configured price;
 * "tool" = cost reported by a paid tool itself.
 */
export type CostSource = "api" | "price-table" | "tool";

/** One model call: who made it, on which model, what it cost. */
export interface UsageRecord extends TokenUsage {
  readonly caller: string;
  readonly model: string;
  readonly costUsd: number;
  readonly costSource: CostSource;
  /**
   * The host that served the call, as its provider names it (#395 PR 6: OpenRouter's upstream —
   * `Fireworks`, `Together`); absent when the provider does not say.
   */
  readonly servedBy?: string;
  /**
   * Its cost is in the ledger already (#333 PR 3): a call of a child that ran on another instance
   * (`ChildPlacement.AnyInstance`), recorded there as it was made — its parent's pass counts it,
   * never writes it again. Absent for every other call.
   */
  readonly isRecordedElsewhere?: boolean;
}

/** What a call was for — the cost categories of a turn. */
export const COST_CATEGORIES = [
  "agents",
  "routing",
  "guards",
  "review",
  "tools",
  "compaction",
  "retrieval",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** Category from the caller name: tool:* and action:* (tools), compaction:*, guardrail:* (guards), router:quality:* and judge:* (review), other router:*, agent. */
export function costCategoryOf(caller: string): CostCategory {
  if (caller.startsWith("judge:")) return "review";
  if (caller.startsWith("tool:") || caller.startsWith("action:")) return "tools";
  if (caller.startsWith("compaction:")) return "compaction";
  if (caller.startsWith("rag:")) return "retrieval";
  if (caller.startsWith("guardrail:")) return "guards";
  if (caller.startsWith("router:quality:")) return "review";
  if (caller.startsWith("router:")) return "routing";
  return "agents";
}

/** One call of the turn, in order. */
export interface CostLine extends TokenUsage {
  readonly caller: string;
  readonly category: CostCategory;
  readonly model: string;
  readonly costUsd: number;
  readonly costSource: CostSource;
  /** The host that served the call (`UsageRecord.servedBy`, #395 PR 6). */
  readonly servedBy?: string;
}

/**
 * Financial result of a turn — part of every run result. Clients routeTo what to show; the core
 * always reports all of it.
 */
export interface CostReport {
  readonly totalUsd: number;
  readonly calls: number;
  readonly cacheReadTokens: number;
  readonly byCaller: Readonly<Record<string, number>>;
  /** Every category is present (0 when unused). */
  readonly byCategory: Readonly<Record<CostCategory, number>>;
  readonly byModel: Readonly<Record<string, number>>;
  /** Every call in the order it happened. */
  readonly trace: readonly CostLine[];
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type UsageMetadata = NonNullable<UsageCarrier["usage_metadata"]>;

const NO_METADATA: UsageMetadata = { input_tokens: 0, output_tokens: 0 };

export function extractTokenUsage(message: UsageCarrier): TokenUsage {
  const usage = message.usage_metadata ?? NO_METADATA;
  const details = usage.input_token_details ?? {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: details.cache_read ?? 0,
    cacheWriteTokens: details.cache_creation ?? 0,
  };
}

export function costOf(usage: TokenUsage, price: Price): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const readPrice = price.cacheReadPerMTok ?? price.inputPerMTok;
  const writePrice = price.cacheWritePerMTok ?? price.inputPerMTok;
  const micro =
    uncached * price.inputPerMTok +
    usage.cacheReadTokens * readPrice +
    usage.cacheWriteTokens * writePrice +
    usage.outputTokens * price.outputPerMTok;
  return micro / 1_000_000;
}

export class ModelCostError extends Error {
  override name = "ModelCostError";
}

/** The cost the provider reported in its replyWith (`usage.cost`), when it did. */
export function reportedCostOf(message: UsageCarrier): number | undefined {
  const usage = message.response_metadata?.usage;
  const cost =
    typeof usage === "object" && usage !== null && "cost" in usage ? usage.cost : undefined;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * One model call's record: the provider's reported cost first (`api`), else tokens × the model's
 * price (`price-table`). A call that has neither cannot be accounted and fails.
 */
export function recordUsage(
  caller: string,
  settings: Pick<ResolvedModelSettings, "model" | "price">,
  message: UsageCarrier,
): UsageRecord {
  const usage = extractTokenUsage(message);
  const servedBy = servedByOf(message.response_metadata);
  const served = servedBy === undefined ? {} : { servedBy };
  const reported = reportedCostOf(message);
  const fallback = fallbackMarkOf(message.response_metadata);
  if (fallback !== undefined) {
    if (reported === undefined) {
      throw new ModelCostError(
        `${caller}: fallback model ${fallback.model} — no cost and no price`,
      );
    }
    const costSource = fallback.priced ? "price-table" : "api";
    return { caller, model: fallback.model, ...usage, costUsd: reported, costSource, ...served };
  }
  if (reported !== undefined) {
    return {
      caller,
      model: settings.model,
      ...usage,
      costUsd: reported,
      costSource: "api",
      ...served,
    };
  }
  if (settings.price === undefined) {
    throw new ModelCostError(
      `${caller}: model ${settings.model} — its provider reported no cost and it has no price`,
    );
  }
  return {
    caller,
    model: settings.model,
    ...usage,
    costUsd: costOf(usage, settings.price),
    costSource: "price-table",
    ...served,
  };
}

export class InvalidToolCostError extends Error {
  override name = "InvalidToolCostError";
}

/** A paid tool's own cost, recorded like a model call: caller `tool:<name>`. */
/** A cost a tool reported, billed to its `costCaller` when it has one (e.g. `rag:<name>`). */
export const recordReportedCost = (
  tool: { readonly name: string; readonly costCaller?: string },
  costUsd: number,
): UsageRecord =>
  tool.costCaller === undefined
    ? recordToolCost(tool.name, costUsd)
    : { ...recordToolCost(tool.name, costUsd), caller: tool.costCaller };

export function recordToolCost(tool: string, costUsd: number): UsageRecord {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new InvalidToolCostError(`Tool "${tool}" reported an invalid cost: ${String(costUsd)}`);
  }
  return { caller: `tool:${tool}`, model: tool, ...ZERO_USAGE, costUsd, costSource: "tool" };
}

/**
 * What calls cost together, in USD: the sum of their records' `costUsd` — what
 * `CostLedgerRepository.saveAll` adds to each counter (a store of your own sums with it, #521).
 */
export function totalCost(records: readonly UsageRecord[]): number {
  return records.reduce((sum, record) => sum + record.costUsd, 0);
}

function sumBy(
  lines: readonly CostLine[],
  key: (line: CostLine) => string,
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const line of lines) sums[key(line)] = (sums[key(line)] ?? 0) + line.costUsd;
  return sums;
}

export function buildCostReport(records: readonly UsageRecord[]): CostReport {
  const trace = records.map((record): CostLine => ({
    ...record,
    category: costCategoryOf(record.caller),
  }));
  const byCategory: Record<CostCategory, number> = {
    agents: 0,
    routing: 0,
    guards: 0,
    review: 0,
    tools: 0,
    compaction: 0,
    retrieval: 0,
  };
  for (const line of trace) byCategory[line.category] += line.costUsd;
  return {
    totalUsd: totalCost(records),
    calls: records.length,
    cacheReadTokens: records.reduce((sum, record) => sum + record.cacheReadTokens, 0),
    byCaller: sumBy(trace, (line) => line.caller),
    byCategory,
    byModel: sumBy(trace, (line) => line.model),
    trace,
  };
}
