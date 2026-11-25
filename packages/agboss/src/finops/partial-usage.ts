import { ConfigError } from "../core/error-families/config-errors.js";
import type { ResolvedModelSettings } from "../config/types.js";
import { NO_PROVIDER } from "./no-provider.js";
import { AIMessage } from "@langchain/core/messages";
import { markedFallbackMessage } from "../models/fallback.js";
import {
  failoverTraceOf,
  partialSpendOf,
  type FallbackServer,
  type PartialSpend,
} from "../models/transport/stream-partial.js";
import { fallbackMarkOf } from "./fallback-mark.js";
import { usd, type Usd } from "../units/index.js";
import { CostSource } from "./cost-source.js";
import {
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

/** The unpriced record of a call no price can be found for: its tokens, 0 USD. */
function unpricedOf(
  caller: string,
  model: string,
  provider: string | undefined,
  usage: TokenUsage,
): UsageRecord {
  return {
    caller,
    model,
    ...usage,
    provider: provider ?? NO_PROVIDER,
    costUsd: usd(0),
    costSource: CostSource.Unpriced,
  };
}

/**
 * The record of one provider's share of a failed call: what it reported, else counted from its
 * chunks; under its own model, price and provider when it is a fallback's (`server`), else the call's.
 */
function shareRecordOf(
  caller: string,
  settings: Settings,
  server: FallbackServer | undefined,
  reported: PartialSpend | undefined,
  call: PartialCall,
): UsageRecord | undefined {
  const usage = usageOf(reported, call);
  const cost = reported?.cost;
  if (nothingSpent(usage) && (cost === undefined || cost === 0)) return undefined;
  const carrier = carrierOf(usage, cost);
  try {
    if (server === undefined) return recordUsage(caller, settings, carrier);
    const message = new AIMessage({
      content: "",
      usage_metadata: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        input_token_details: {
          cache_read: usage.cacheReadTokens,
          cache_creation: usage.cacheWriteTokens,
        },
      },
      response_metadata: cost === undefined ? {} : { usage: { cost } },
    });
    return recordUsage(caller, settings, markedFallbackMessage(message, server));
  } catch (failure) {
    if (!(failure instanceof ConfigError.Component)) throw failure;
    return server === undefined
      ? unpricedOf(caller, settings.model, settings.modelProvider, usage)
      : unpricedOf(caller, server.model, server.provider, usage);
  }
}

/** The record of the spend of `error`'s failed call, or none when nothing was spent. */
export function partialUsageRecordOf(
  caller: string,
  settings: Settings,
  error: unknown,
  call: PartialCall,
): UsageRecord | undefined {
  return partialUsageRecordsOf(caller, settings, error, call)[0];
}

/**
 * Every record of a failed call's spend: when a fallback chain was serving it, each provider's share
 * under its own provider, model and price (#1399) — the providers that failed before (what they
 * reported, else their chunks), and the one that was serving when it failed. The characters the call
 * heard are split: those of the earlier shares are theirs, the rest the serving provider's. A provider's
 * report and the chunk count of the same share are never both recorded.
 */
export function partialUsageRecordsOf(
  caller: string,
  settings: Settings,
  error: unknown,
  call: PartialCall,
): readonly UsageRecord[] {
  const trace = failoverTraceOf(error);
  const earlier = trace?.earlier ?? [];
  const earlierRecords = earlier.map((share) =>
    shareRecordOf(caller, settings, share.server, share.reported, {
      requestChars: call.requestChars,
      answerChars: share.chars,
    }),
  );
  const earlierChars = earlier.reduce((sum, share) => sum + share.chars, 0);
  const serving = shareRecordOf(caller, settings, trace?.server, partialSpendOf(error), {
    requestChars: call.requestChars,
    answerChars: Math.max(0, call.answerChars - earlierChars),
  });
  return [...earlierRecords, serving].filter((record) => record !== undefined);
}

/**
 * The records of what providers before the one that answered spent on a call that was served by a
 * fallback after they failed (#1399): each under its own provider, model and price.
 */
export function earlierUsageRecordsOf(
  caller: string,
  settings: Settings,
  metadata: Readonly<Record<string, unknown>> | undefined,
  requestChars: number,
): readonly UsageRecord[] {
  const earlier = fallbackMarkOf(metadata)?.earlier ?? [];
  return earlier
    .map((share) =>
      shareRecordOf(caller, settings, share.server, share.reported, {
        requestChars,
        answerChars: share.chars,
      }),
    )
    .filter((record) => record !== undefined);
}
