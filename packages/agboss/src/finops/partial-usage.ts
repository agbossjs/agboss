import type { ResolvedModelSettings } from "../config/types.js";
import { partialSpendOf, type PartialSpend } from "../models/transport/stream-partial.js";
import { usd, type Usd } from "../units/index.js";
import { CostSource } from "./cost-source.js";
import {
  ModelCostError,
  ZERO_USAGE,
  recordUsage,
  type TokenUsage,
  type UsageCarrier,
  type UsageRecord,
} from "./usage.js";

/**
 * The spend of a model call that failed mid-way (#1399). The provider bills the tokens it produced
 * before it failed, so they are accounted like a completed call's: what the provider reported (the
 * stream's `result`, carried by the error), else what was counted from the chunks that came — a
 * token is about 4 characters, the prompt's size the request's. Priced as a completed call is; one
 * that cannot be priced is `CostSource.Unpriced` tokens, never dropped. Nothing came, nothing
 * reported: no record.
 */

/** What a call that failed had received: the characters of the request and of the answer so far. */
export interface PartialCall {
  readonly requestChars: number;
  readonly answerChars: number;
}

const CHARS_PER_TOKEN = 4;

/** An estimate of the tokens of `chars` characters, never below 1 for any text. */
const tokensOfChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

type Settings = Pick<ResolvedModelSettings, "model" | "price" | "modelProvider" | "unpriced">;

const nothingSpent = (usage: TokenUsage): boolean =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0;

/** What the failed call used: the provider's report, else counted from the chunks that came. */
function usageOf(reported: PartialSpend | undefined, call: PartialCall): TokenUsage {
  if (reported !== undefined) return reported.usage;
  if (call.answerChars === 0) return ZERO_USAGE;
  return {
    ...ZERO_USAGE,
    inputTokens: tokensOfChars(call.requestChars),
    outputTokens: tokensOfChars(call.answerChars),
  };
}

/** The usage as a message carries it, with the cost the provider reported. */
function carrierOf(usage: TokenUsage, cost: Usd | undefined): UsageCarrier {
  return {
    usage_metadata: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      input_token_details: {
        cache_read: usage.cacheReadTokens,
        cache_creation: usage.cacheWriteTokens,
      },
    },
    ...(cost === undefined ? {} : { response_metadata: { usage: { cost } } }),
  };
}

/** The record of the spend of `error`'s failed call, or none when nothing was spent. */
export function partialUsageRecordOf(
  caller: string,
  settings: Settings,
  error: unknown,
  call: PartialCall,
): UsageRecord | undefined {
  const reported = partialSpendOf(error);
  const usage = usageOf(reported, call);
  const cost = reported?.cost;
  if (nothingSpent(usage) && (cost === undefined || cost === 0)) return undefined;
  try {
    return recordUsage(caller, settings, carrierOf(usage, cost));
  } catch (failure) {
    if (!(failure instanceof ModelCostError)) throw failure;
    const provider =
      settings.modelProvider === undefined ? {} : { provider: settings.modelProvider };
    return {
      caller,
      model: settings.model,
      ...usage,
      ...provider,
      costUsd: usd(0),
      costSource: CostSource.Unpriced,
    };
  }
}
