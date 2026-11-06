import type { Price, ResolvedModelSettings } from "../config/types.js";
import type { Usd } from "../units/index.js";
import { fallbackMarkOf } from "./fallback-mark.js";
import type { LedgerKey } from "./ledger-key.js";
import { CostCategory, costCategoryOf } from "./cost-category.js";
import { servedByOf } from "./served-by.js";
import { withoutLedgerMarks, type LedgerMark } from "./ledger-mark.js";

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

/** Where a call's cost comes from. */
export enum CostSource {
  /** Reported by the provider: exact. */
  Api = "api",
  /** Tokens × the model's configured price. */
  PriceTable = "price-table",
  /** Reported by a paid tool (or a service step) itself. */
  Tool = "tool",
}

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
   * Where the ledger holds its cost (#333 PR 3, #727, #771): absent while it is not in the ledger
   * yet — its pass writes it —; `LedgerState.Written` once a pass wrote it as it was made, under its
   * `ledgerId` and dated `madeAt`; `LedgerState.RecordedElsewhere` for a call of a child that ran on
   * another instance, recorded there. A record in the ledger is never written again, and counted
   * once. Read it with `ledgerMarkOf(record)`, which also reads a record kept before 0.1.1.
   */
  readonly ledger?: LedgerMark;
  /**
   * The spend's identity on every pass that makes it (#810): a charge a step makes again after a
   * takeover is written under `ledgerKey.id`, dated `ledgerKey.madeAt`, so the ledger adds it once
   * whichever pass writes it first. Absent: its entry gets an id of the pass that made it.
   */
  readonly ledgerKey?: LedgerKey;
}

export { CostCategory, costCategoryOf } from "./cost-category.js";

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
    if (reported === undefined)
      throw new ModelCostError(
        `${caller}: fallback model ${fallback.model} — no cost and no price`,
      );
    const costSource = fallback.priced ? CostSource.PriceTable : CostSource.Api;
    return { caller, model: fallback.model, ...usage, costUsd: reported, costSource, ...served };
  }
  if (reported !== undefined) {
    return {
      caller,
      model: settings.model,
      ...usage,
      costUsd: reported,
      costSource: CostSource.Api,
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
    costSource: CostSource.PriceTable,
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
  return {
    caller: `tool:${tool}`,
    model: tool,
    ...ZERO_USAGE,
    costUsd,
    costSource: CostSource.Tool,
  };
}

/**
 * What calls cost together, in USD: the sum of their records' `costUsd` — what
 * `CostLedgerRepository.saveAll` adds to each counter (a store of your own sums its entries with
 * it, #521: their total is `Usd`).
 */
export function totalCost(entries: readonly (UsageRecord & { readonly costUsd: Usd })[]): Usd;
export function totalCost(records: readonly UsageRecord[]): number;
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
    ...withoutLedgerMarks(record),
    category: costCategoryOf(record.caller),
  }));
  const byCategory: Record<CostCategory, number> = {
    [CostCategory.Agents]: 0,
    [CostCategory.Routing]: 0,
    [CostCategory.Guards]: 0,
    [CostCategory.Review]: 0,
    [CostCategory.Tools]: 0,
    [CostCategory.Compaction]: 0,
    [CostCategory.Retrieval]: 0,
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
