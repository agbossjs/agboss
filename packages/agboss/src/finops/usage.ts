import { ConfigError } from "../core/error-families/config-errors.js";
import { NO_PROVIDER } from "./no-provider.js";
import { isFiniteNumber } from "../graph/count-limit.js";
import { checkedPrice } from "../models/cost.js";
import type { ResolvedModelSettings } from "../config/types.js";
import type { ModelPrice } from "../models/cost.js";
import { usd, type Usd } from "../units/index.js";
import { fallbackMarkOf } from "./fallback-mark.js";
import type { CostCategory } from "./cost-category.js";
import { CostSource } from "./cost-source.js";
import { servedByOf } from "./served-by.js";
import type { LedgerKey, LedgerMark } from "./ledger-mark.js";

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
  /** The prompt's tokens, the cached ones included. */
  readonly inputTokens: number;
  /** The answer's tokens. */
  readonly outputTokens: number;
  /** The prompt's tokens read from the provider's cache (0 when none). */
  readonly cacheReadTokens: number;
  /** The prompt's tokens written to the provider's cache (0 when none). */
  readonly cacheWriteTokens: number;
}

/** One model call: who made it, on which model, what it cost. */
export interface UsageRecord extends TokenUsage {
  readonly caller: string;
  readonly model: string;
  readonly costUsd: Usd;
  readonly costSource: CostSource;
  /**
   * The host that served the call, as its provider names it (#395 PR 6: OpenRouter's upstream —
   * `Fireworks`, `Together`); absent when the provider does not say.
   */
  readonly servedBy?: string;
  /**
   * The `@ModelProvider` that served the call, by its `name` (#1313); `NO_PROVIDER` for a charge no
   * model provider made (a tool's, a mesh peer's) and for a model no provider names.
   */
  readonly provider: string;
  /**
   * Where the ledger holds its cost (#333 PR 3, #727, #771): absent while it is not in the ledger
   * yet — its pass writes it —; `LedgerState.Written` once a pass wrote it as it was made, under its
   * `ledgerId` and dated `madeAt`; `LedgerState.RecordedElsewhere` for a call of a child that ran on
   * another instance, recorded there. A record in the ledger is never written again, and counted
   * once. Read it with `ledgerMarkOf(record)`.
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
export { CostSource } from "./cost-source.js";
export { NO_PROVIDER } from "./no-provider.js";
export { CostReport, tokensOf, totalCost, totalTokens } from "./cost-report.js";

/** One call of the turn, in order. */
export interface CostLine extends TokenUsage {
  readonly caller: string;
  readonly category: CostCategory;
  readonly model: string;
  readonly costUsd: Usd;
  readonly costSource: CostSource;
  /** The host that served the call (`UsageRecord.servedBy`, #395 PR 6). */
  readonly servedBy?: string;
  /** The provider that served the call (`UsageRecord.provider`, #1313). */
  readonly provider: string;
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

export function costOf(usage: TokenUsage, unchecked: ModelPrice): number {
  const price = checkedPrice(unchecked);
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const readPrice = price.cacheReadPerMillion ?? price.inputPerMillion;
  const writePrice = price.cacheWritePerMillion ?? price.inputPerMillion;
  const micro =
    uncached * price.inputPerMillion +
    usage.cacheReadTokens * readPrice +
    usage.cacheWriteTokens * writePrice +
    usage.outputTokens * price.outputPerMillion;
  return micro / 1_000_000;
}

/** The cost the provider reported in its replyWith (`usage.cost`), when it did. */
export function reportedCostOf(message: UsageCarrier): Usd | undefined {
  const usage = message.response_metadata?.usage;
  const cost =
    typeof usage === "object" && usage !== null && "cost" in usage ? usage.cost : undefined;
  return isFiniteNumber(cost) && cost >= 0 ? usd(cost) : undefined;
}

/** The record of a call a fallback answered: its model, its reported cost, else unpriced (#202, #1313). */
function fallbackRecordOf(
  caller: string,
  fallback: NonNullable<ReturnType<typeof fallbackMarkOf>>,
  reported: Usd | undefined,
  made: Pick<UsageRecord, "servedBy" | keyof TokenUsage>,
): UsageRecord {
  const base = {
    caller,
    model: fallback.model,
    ...made,
    provider: fallback.provider ?? NO_PROVIDER,
  };
  if (reported !== undefined) {
    const costSource = fallback.priced ? CostSource.PriceTable : CostSource.Api;
    return { ...base, costUsd: reported, costSource };
  }
  if (fallback.unpriced) return { ...base, costUsd: usd(0), costSource: CostSource.Unpriced };
  throw new ConfigError.ModelCost({
    model: fallback.model,
    message: `${caller}: fallback model ${fallback.model} — no cost and no price`,
  });
}

/**
 * One model call's record: the provider's reported cost first (`api`), else tokens × the model's
 * price (`price-table`). A call that has neither cannot be accounted and fails — unless its provider
 * has no `cost` at all (#1313): that call is `unpriced`, 0 USD with its tokens, which a token budget
 * still counts.
 */
export function recordUsage(
  caller: string,
  settings: Pick<ResolvedModelSettings, "model" | "price" | "modelProvider" | "unpriced">,
  message: UsageCarrier,
): UsageRecord {
  const usage = extractTokenUsage(message);
  const servedBy = servedByOf(message.response_metadata);
  const served = servedBy === undefined ? {} : { servedBy };
  const reported = reportedCostOf(message);
  const fallback = fallbackMarkOf(message.response_metadata);
  if (fallback !== undefined)
    return fallbackRecordOf(caller, fallback, reported, { ...usage, ...served });
  const provider = settings.modelProvider ?? NO_PROVIDER;
  const made = { caller, model: settings.model, ...usage, ...served, provider };
  if (reported !== undefined) return { ...made, costUsd: reported, costSource: CostSource.Api };
  if (settings.price !== undefined)
    return { ...made, ...pricedOf(caller, settings.model, settings.price, usage) };
  if (settings.unpriced === true)
    return { ...made, costUsd: usd(0), costSource: CostSource.Unpriced };
  throw new ConfigError.ModelCost({
    model: settings.model,
    message: `${caller}: model ${settings.model} — its provider reported no cost and it has no price`,
  });
}

/**
 * The record of a call its provider answered — and billed — that `recordUsage` could not price (it
 * threw a `ConfigError.ModelCost`): its tokens at 0 USD, `CostSource.Unpriced`, under the model and provider
 * that served it (bughunt 2026-11-25 #2). The call still fails as it did; its tokens are never dropped,
 * so a token budget counts them.
 */
export function unpricedUsageOf(
  caller: string,
  settings: Pick<ResolvedModelSettings, "model" | "modelProvider">,
  message: UsageCarrier,
): UsageRecord {
  const usage = extractTokenUsage(message);
  const servedBy = servedByOf(message.response_metadata);
  const fallback = fallbackMarkOf(message.response_metadata);
  return {
    caller,
    model: fallback?.model ?? settings.model,
    ...usage,
    ...(servedBy === undefined ? {} : { servedBy }),
    provider: (fallback === undefined ? settings.modelProvider : fallback.provider) ?? NO_PROVIDER,
    costUsd: usd(0),
    costSource: CostSource.Unpriced,
  };
}

/** The cost of a call's tokens at the model's price: no amount (NaN) is never accounted (#817). */
function pricedOf(
  caller: string,
  model: string,
  price: ModelPrice,
  usage: TokenUsage,
): Pick<UsageRecord, "costUsd" | "costSource"> {
  const priced = costOf(usage, price);
  if (!Number.isFinite(priced) || priced < 0)
    throw new ConfigError.ModelCost({
      model,
      field: "price",
      message: `${caller}: model ${model} — its tokens price at no amount: ${String(priced)}`,
    });
  return { costUsd: usd(priced), costSource: CostSource.PriceTable };
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
    throw new ConfigError.Component({
      message: `Tool "${tool}" reported an invalid cost: ${String(costUsd)}`,
    });
  }
  return {
    caller: `tool:${tool}`,
    model: tool,
    provider: NO_PROVIDER,
    ...ZERO_USAGE,
    costUsd: usd(costUsd),
    costSource: CostSource.Tool,
  };
}
