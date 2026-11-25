import type { Price } from "../config/types.js";

/** What a model use says of its account: its model, the provider its cascade resolved, its own price. */
export interface PricedUse {
  readonly model: string;
  readonly modelProvider?: string | undefined;
  readonly price?: Price | undefined;
  readonly unpriced?: true | undefined;
}

/**
 * Prices a model use by its own provider and model (bughunt 2026-11-25 #2): the price its settings
 * give, else the entry of the provider its cascade resolved for that model, keyed by the provider and
 * never by the model's name alone; a provider with no `cost` marks it `unpriced` (0 USD, tokens kept).
 * Every model-backed component's settings go through one of these before their first call.
 */
export type ModelPricing = <T extends PricedUse>(settings: T) => T;

/** A use as it is: a registry built with no provider directory (a test of its bindings). */
export const asDeclared: ModelPricing = (settings) => settings;
