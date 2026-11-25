import { z } from "zod";
import type { ModelPricing, PricedUse } from "../models/model-pricing.js";
import { usd } from "../units/index.js";
import { CostSource } from "./cost-source.js";
import { NO_PROVIDER } from "./no-provider.js";
import { costOf, type UsageRecord } from "./usage.js";

/**
 * A decision call priced by its own provider and model (bughunt 2026-11-25 #2): a decisions provider
 * whose `cost` is a price table, or none, is accounted like a chat provider of that cost — the answer's
 * tokens × its table's price (`CostSource.PriceTable`), or 0 USD with its tokens (`CostSource.Unpriced`).
 * A cost the provider reported is kept as it is.
 */

const Reported = z.object({
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
      total_cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

type Usage = z.infer<typeof Reported>["usage"];

/**
 * `record` priced by the table of the provider it is recorded under, for `model` — the model the call
 * asked (or the fallback that answered was asked), not the name the answer reports — when the answer
 * `raw` reported no cost. No pricing (a test's gateway) or a provider whose cost is reported: as it is.
 */
export function pricedDecisionRecord(
  record: UsageRecord,
  raw: unknown,
  model: string,
  pricing: ModelPricing | undefined,
): UsageRecord {
  if (pricing === undefined || record.provider === NO_PROVIDER) return record;
  const usage = reportedOf(raw);
  if (usage?.cost !== undefined || usage?.total_cost !== undefined) return record;
  const settings = pricing({ model, modelProvider: record.provider });
  return tablePricedOf(record, countedOf(record, usage), settings);
}

/** The record with the tokens the answer reported, else its own. */
const countedOf = (record: UsageRecord, usage: Usage): UsageRecord => ({
  ...record,
  inputTokens: usage?.input_tokens ?? record.inputTokens,
  outputTokens: usage?.output_tokens ?? record.outputTokens,
});

/** The record at its provider's price for its tokens, unpriced when it has no cost, else as it was. */
function tablePricedOf(
  record: UsageRecord,
  counted: UsageRecord,
  settings: PricedUse,
): UsageRecord {
  if (settings.price !== undefined)
    return {
      ...counted,
      costUsd: usd(costOf(counted, settings.price)),
      costSource: CostSource.PriceTable,
    };
  if (settings.unpriced === true)
    return { ...counted, costUsd: usd(0), costSource: CostSource.Unpriced };
  return record;
}

/** What the answer reported of its usage; none for an answer that is no such object. */
function reportedOf(raw: unknown): Usage {
  const parsed = Reported.safeParse(raw);
  return parsed.success ? parsed.data.usage : undefined;
}
