import type { Price } from "../config/types.js";
import { isFiniteNumber, shownLimit } from "../graph/count-limit.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import type { Usd } from "../units/index.js";

/**
 * USD per one million tokens of a model. A cache price left out is the input price: tokens a call read from the
 * cache cost `cacheReadPerMillion`, tokens it wrote to the cache cost `cacheWritePerMillion`.
 */
export interface ModelPrice {
  readonly inputPerMillion: Usd;
  readonly outputPerMillion: Usd;
  readonly cacheReadPerMillion?: Usd | undefined;
  readonly cacheWritePerMillion?: Usd | undefined;
}

/** Prices by model name. */
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/** Where a provider's call cost comes from: its own replyWith, or a price table. */
export type ModelCost =
  | { readonly kind: "from-response" }
  | { readonly kind: "from-prices"; readonly prices: ModelPrices };

const REQUIRED_FIELDS = ["inputPerMillion", "outputPerMillion"] as const;
const CACHE_FIELDS = ["cacheReadPerMillion", "cacheWritePerMillion"] as const;
const AMOUNT_RULE = "not a finite number of dollars from 0 (usd(...))";

const isAmount = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
const notATable = (value: unknown): string =>
  `the price table is ${shownLimit(value)}, not an object of prices`;
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/**
 * Why one table entry is no price (#1385): a field that is no finite number of dollars from 0 (a negative one
 * would take from a call's cost, a `NaN` one would make it no amount), or an entry that is no object. The field
 * by its name and the value by its kind or number; never the model, which is the caller's text.
 */
export function modelPriceProblemOf(price: unknown): string | undefined {
  if (!isObject(price)) return `a price table entry is ${shownLimit(price)}, not a price object`;
  for (const field of REQUIRED_FIELDS) {
    const value: unknown = Reflect.get(price, field);
    if (!isAmount(value)) return `${field} is ${shownLimit(value)}, ${AMOUNT_RULE}`;
  }
  for (const field of CACHE_FIELDS) {
    const value: unknown = Reflect.get(price, field);
    if (value !== undefined && !isAmount(value))
      return `${field} is ${shownLimit(value)}, ${AMOUNT_RULE}`;
  }
  return undefined;
}

/**
 * Why a price table is none (#1385): it is no object, or one of its entries is no price. A `ModelCost` is a
 * public union, so a literal (and a table changed after it was made) reaches the accounting unchecked unless
 * every use checks it: `ModelCost.fromPrices`, assembly (`[model.price-invalid]`) and `priceOf` all use this.
 */
export function modelPricesProblemOf(prices: unknown): string | undefined {
  if (!isObject(prices)) return notATable(prices);
  return Object.values(prices)
    .map(modelPriceProblemOf)
    .find((problem) => problem !== undefined);
}

const priceError = (problem: string): ConfigError.Unit =>
  new ConfigError.Unit({ message: `[model.price-invalid] ${problem}` });

/** A price entry copied and frozen: the caller's own object is never kept, so it cannot change the table later. */
const frozenPrice = (price: ModelPrice): ModelPrice =>
  Object.freeze({
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    ...(price.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadPerMillion: price.cacheReadPerMillion }),
    ...(price.cacheWritePerMillion === undefined
      ? {}
      : { cacheWritePerMillion: price.cacheWritePerMillion }),
  });

export const ModelCost = {
  /** The provider reports each call's cost in its replyWith (OpenRouter `usage.cost`). */
  fromResponse(): ModelCost {
    return Object.freeze({ kind: "from-response" });
  },
  /**
   * Tokens × the price of the model (a local server, a provider that reports no cost). Every price is a finite
   * number of dollars from 0 (#1382, #1385), refused here with a `ConfigError.Unit` otherwise, and the table keeps its
   * own frozen copy of each entry.
   */
  fromPrices(prices: ModelPrices): ModelCost {
    const problem = modelPricesProblemOf(prices);
    if (problem !== undefined) throw priceError(problem);
    const entries = Object.entries(prices).map(([model, price]): [string, ModelPrice] => [
      model,
      frozenPrice(price),
    ]);
    return Object.freeze({
      kind: "from-prices",
      prices: Object.freeze(Object.fromEntries(entries)),
    });
  },
};

/**
 * The price table entry of a model as the accounting reads it; none for `fromResponse` or a model the table does
 * not list. The entry is checked here, at its use (#1385): a literal `ModelCost` or a table changed after it was
 * made throws a `ConfigError.Unit` `[model.price-invalid]` before any cost is computed.
 */
export function priceOf(cost: ModelCost, model: string): Price | undefined {
  if (cost.kind === "from-response") return undefined;
  const table: unknown = cost.prices;
  if (!isObject(table)) throw priceError(notATable(table));
  const price = Object.hasOwn(table, model) ? cost.prices[model] : undefined;
  if (price === undefined) return undefined;
  const problem = modelPriceProblemOf(price);
  if (problem !== undefined) throw priceError(problem);
  return {
    inputPerMTok: price.inputPerMillion,
    outputPerMTok: price.outputPerMillion,
    ...(price.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadPerMTok: price.cacheReadPerMillion }),
    ...(price.cacheWritePerMillion === undefined
      ? {}
      : { cacheWritePerMTok: price.cacheWritePerMillion }),
  };
}

/** The fields of a `Price`, each with whether it must be set. */
const PRICE_FIELDS = [
  ["inputPerMTok", true],
  ["outputPerMTok", true],
  ["cacheReadPerMTok", false],
  ["cacheWritePerMTok", false],
] as const;

/**
 * A price a call is costed by (#1385), whichever way it came — a config `price`, a provider's table, a
 * fallback's: every field is a finite number of dollars from 0, or (a cache price) unset. A negative price would
 * take from the cost of the tokens another price adds. A price that is none throws a `ConfigError.Unit`
 * `[model.price-invalid]` before any cost is computed; the message names the field and the value's kind, never
 * the model.
 */
export function checkedPrice(price: Price): Price {
  for (const [field, required] of PRICE_FIELDS) {
    const value: unknown = Reflect.get(price, field);
    if (!required && value === undefined) continue;
    if (!isAmount(value)) throw priceError(`${field} is ${shownLimit(value)}, ${AMOUNT_RULE}`);
  }
  return price;
}

/** How a cost source reads in the startup log. */
export const costLabel = (cost: ModelCost): string =>
  cost.kind === "from-response" ? "cost from the response" : "cost from the price table";
