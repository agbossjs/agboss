import { z } from "zod";
import { usd, type Usd } from "../units/index.js";
import { CostCategory, costCategoryOf, NO_COST_BY_CATEGORY } from "./cost-category.js";
import { CostSource } from "./cost-source.js";
import { withoutLedgerMarks } from "./ledger-mark.js";
import type { CostLine, TokenUsage, UsageRecord } from "./usage.js";

/**
 * Financial result of a turn — part of every run result. Clients routeTo what to show; the core
 * always reports all of it. Build one with `CostReport.fromUsage(records)`, `CostReport.empty()` or
 * `CostReport.sum(reports)`.
 */
export interface CostReport {
  /** The known total: what every call of known cost cost. */
  readonly totalUsd: Usd;
  /** The calls of known cost. */
  readonly calls: number;
  /**
   * The lost passes of a step whose cost is not known (#853, `CostSource.Unknown`): each a pass that
   * lost its lease mid step, run again by a recovery — none in `totalUsd`, `calls` or the sums.
   */
  readonly unknownCalls: number;
  /** The prompts' tokens of the known calls, the cached ones included. */
  readonly inputTokens: number;
  /** The answers' tokens of the known calls. */
  readonly outputTokens: number;
  /** The prompts' tokens read from a provider's cache. */
  readonly cacheReadTokens: number;
  /** The prompts' tokens written to a provider's cache. */
  readonly cacheWriteTokens: number;
  /** `inputTokens + outputTokens`: what a token budget (`maxTokens`) counts. */
  readonly totalTokens: number;
  readonly byCaller: Readonly<Record<string, Usd>>;
  /** Every category is present (`usd(0)` when unused). */
  readonly byCategory: Readonly<Record<CostCategory, Usd>>;
  readonly byModel: Readonly<Record<string, Usd>>;
  /** What each `@ModelProvider` (by `name`) was paid (#1313); a call with no provider is in none. */
  readonly byProvider: Readonly<Record<string, Usd>>;
  /** Every call in the order it happened. */
  readonly trace: readonly CostLine[];
}

/**
 * What calls cost together, in USD: the sum of their records' `costUsd` — what
 * `CostLedgerRepository.saveAll` adds to each counter (a store of your own sums its entries with
 * it, #521).
 */
export function totalCost(records: readonly { readonly costUsd: Usd }[]): Usd {
  return usd(records.reduce((sum, record) => sum + record.costUsd, 0));
}

/**
 * The tokens a token budget counts (#1318): input plus output. The cache's tokens are inside
 * `inputTokens` (OpenAI-compatible accounting), never counted twice.
 */
export const tokensOf = (usage: Pick<TokenUsage, "inputTokens" | "outputTokens">): number =>
  usage.inputTokens + usage.outputTokens;

/** What calls used together, in tokens: the sum of `tokensOf` of their records. */
export function totalTokens(
  records: readonly Pick<TokenUsage, "inputTokens" | "outputTokens">[],
): number {
  return records.reduce((sum, record) => sum + tokensOf(record), 0);
}

function sumBy(lines: readonly CostLine[], key: (line: CostLine) => string): Record<string, Usd> {
  const sums: Record<string, number> = {};
  for (const line of lines) sums[key(line)] = (sums[key(line)] ?? 0) + line.costUsd;
  return Object.fromEntries(Object.entries(sums).map(([name, sum]) => [name, usd(sum)]));
}

const tokenSum = (lines: readonly CostLine[], field: keyof TokenUsage): number =>
  lines.reduce((sum, line) => sum + line[field], 0);

/** The report of `records`: every call in its trace, the lost passes (#853) counted apart. */
const reportOf = (records: readonly UsageRecord[]): CostReport => {
  const trace = records.map((record): CostLine => ({
    ...withoutLedgerMarks(record),
    category: costCategoryOf(record.caller),
  }));
  const byCategory: Record<CostCategory, number> = { ...NO_COST_BY_CATEGORY };
  for (const line of trace) byCategory[line.category] += line.costUsd;
  // a lost pass's record (#853): in the trace, of no amount, counted apart from the calls
  const known = trace.filter((line) => line.costSource !== CostSource.Unknown);
  const inputTokens = tokenSum(known, "inputTokens");
  const outputTokens = tokenSum(known, "outputTokens");
  return {
    totalUsd: totalCost(records),
    calls: known.length,
    unknownCalls: trace.length - known.length,
    inputTokens,
    outputTokens,
    cacheReadTokens: tokenSum(known, "cacheReadTokens"),
    cacheWriteTokens: tokenSum(known, "cacheWriteTokens"),
    totalTokens: inputTokens + outputTokens,
    byCaller: sumBy(known, (line) => line.caller),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([category, sum]) => [category, usd(sum)]),
    ) as Record<CostCategory, Usd>,
    byModel: sumBy(known, (line) => line.model),
    byProvider: sumBy(
      known.filter((line) => line.provider !== undefined),
      (line) => line.provider ?? "",
    ),
    trace,
  };
};

/** A trace line as the usage record it came from (its category is read from the caller again). */
const recordOfLine = (line: CostLine): UsageRecord => ({
  caller: line.caller,
  model: line.model,
  inputTokens: line.inputTokens,
  outputTokens: line.outputTokens,
  cacheReadTokens: line.cacheReadTokens,
  cacheWriteTokens: line.cacheWriteTokens,
  costUsd: line.costUsd,
  costSource: line.costSource,
  ...(line.servedBy === undefined ? {} : { servedBy: line.servedBy }),
  ...(line.provider === undefined ? {} : { provider: line.provider }),
});

/** Builds a `CostReport`: `fromUsage(records)`, `empty()`, `sum(reports)` (the calls of reports together). */
export const CostReport = {
  fromUsage: (records: readonly UsageRecord[]): CostReport => reportOf(records),
  empty: (): CostReport => reportOf([]),
  sum: (reports: readonly CostReport[]): CostReport =>
    reportOf(reports.flatMap((report) => report.trace.map(recordOfLine))),
} as const;

/** An amount in USD as stored: finite and ≥ 0, branded; a stored value that is not one is unreadable. */
export const storedUsd = z
  .number()
  .refine((amount) => Number.isFinite(amount) && amount >= 0)
  .transform((amount) => usd(amount));

/**
 * What an execution may still spend in USD, as a strategy or a compaction sees it
 * (`budgetLeftUsd`): `undefined` when no budget limits USD — none at all, or only token budgets
 * (`Infinity` in the execution's own bookkeeping) —, else an amount ≥ 0.
 */
export const budgetLeftOf = (budgetUsd: number): Usd | undefined =>
  Number.isFinite(budgetUsd) ? usd(Math.max(0, budgetUsd)) : undefined;

/** `left` after `spent` more: `undefined` stays unlimited, an amount never goes below 0. */
export const budgetLeftAfter = (left: Usd | undefined, spent: Usd): Usd | undefined =>
  left === undefined ? undefined : usd(Math.max(0, left - spent));

/** Whether `left` is used up: an amount at 0 (`undefined` is never used up). */
export const isBudgetLeftUsed = (left: Usd | undefined): boolean => left !== undefined && left <= 0;
