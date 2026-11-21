import type { Price } from "../config/types.js";
import { isFiniteNumber, shownLimit } from "../graph/count-limit.js";
import { UnitError, type Usd } from "../units/index.js";

/** USD per one million tokens of a model; cached input falls back to the input price. */
export interface ModelPrice {
  readonly inputPerMillion: Usd;
  readonly outputPerMillion: Usd;
  readonly cachedInputPerMillion?: Usd;
}

/** Prices by model name. */
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/** Where a provider's call cost comes from: its own replyWith, or a price table. */
export type ModelCost =
  | { readonly kind: "from-response" }
  | { readonly kind: "from-prices"; readonly prices: ModelPrices };

const PRICE_FIELDS = ["inputPerMillion", "outputPerMillion", "cachedInputPerMillion"] as const;

/**
 * Every price of a table is a finite number of dollars from 0 (#1382): a negative one would take from a call's
 * cost, a `NaN` one would make it no amount. Refused when the table is made, naming the model and the field,
 * the value by its kind or number.
 */
function checkedPrices(prices: ModelPrices): ModelPrices {
  for (const [model, price] of Object.entries(prices)) {
    for (const field of PRICE_FIELDS) {
      const value: unknown = price[field];
      if (value === undefined || (isFiniteNumber(value) && value >= 0)) continue;
      throw new UnitError({
        message: `ModelCost.fromPrices: ${model}.${field} must be a finite number of dollars from 0 (usd(...)), got ${shownLimit(value)}`,
      });
    }
  }
  return prices;
}

export const ModelCost = {
  /** The provider reports each call's cost in its replyWith (OpenRouter `usage.cost`). */
  fromResponse(): ModelCost {
    return Object.freeze({ kind: "from-response" });
  },
  /** Tokens × the price of the model (a local server, a provider that reports no cost). */
  fromPrices(prices: ModelPrices): ModelCost {
    return Object.freeze({
      kind: "from-prices",
      prices: Object.freeze({ ...checkedPrices(prices) }),
    });
  },
};

/** The price table entry of a model as the accounting reads it; none for `fromResponse`. */
export function priceOf(cost: ModelCost, model: string): Price | undefined {
  if (cost.kind === "from-response") return undefined;
  const price = cost.prices[model];
  if (price === undefined) return undefined;
  return {
    inputPerMTok: price.inputPerMillion,
    outputPerMTok: price.outputPerMillion,
    ...(price.cachedInputPerMillion === undefined
      ? {}
      : { cacheReadPerMTok: price.cachedInputPerMillion }),
  };
}

/** How a cost source reads in the startup log. */
export const costLabel = (cost: ModelCost): string =>
  cost.kind === "from-response" ? "cost from the response" : "cost from the price table";
