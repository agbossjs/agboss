import type { Thinking } from "../config/types.js";
import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";

/** How hard a model thinks before it answers. */
export enum ReasoningEffort {
  Minimal = "minimal",
  Low = "low",
  Medium = "medium",
  High = "high",
  ExtraHigh = "xhigh",
}

/** A thinking budget in tokens. */
export interface ReasoningBudget {
  readonly tokens: number;
}

/** `Reasoning.on({ … })`: an effort, a budget, or both (where the model takes both). */
export interface ReasoningOnOptions {
  readonly effort?: ReasoningEffort;
  readonly budget?: ReasoningBudget;
}

/** Whether and how a model reasons: the model decides (nothing sent), on, or off. */
export type Reasoning =
  | { readonly kind: "model-decides" }
  | ({ readonly kind: "on" } & ReasoningOnOptions)
  | { readonly kind: "off" };

/**
 * A value out of range, as the platform's `RangeError`, so `catch` keeps telling it from other errors;
 * made as every framework error is (#906): `{ message, cause }`, with a literal `code`.
 */
export class ReasoningError extends RangeError {
  static readonly code = "config.reasoning" as const;
  readonly code = ReasoningError.code;
  override name = "ReasoningError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

export const Reasoning = {
  modelDecides(): Reasoning {
    return Object.freeze({ kind: "model-decides" });
  },
  on(options: ReasoningOnOptions): Reasoning {
    if (options.effort === undefined && options.budget === undefined) {
      throw new ReasoningError({ message: "Reasoning.on needs an effort, a budget or both" });
    }
    if (
      options.budget !== undefined &&
      !(Number.isInteger(options.budget.tokens) && options.budget.tokens > 0)
    ) {
      throw new ReasoningError({
        message: `a reasoning budget is a positive whole number of tokens, got ${String(options.budget.tokens)}`,
      });
    }
    return Object.freeze({ kind: "on", ...options });
  },
  off(): Reasoning {
    return Object.freeze({ kind: "off" });
  },
};

const isEffort = (value: string): value is ReasoningEffort =>
  (Object.values(ReasoningEffort) as readonly string[]).includes(value);

/** Today's component `thinking` (until #152 brings `reasoning` to the decorators) as a `Reasoning`. */
export function reasoningOfThinking(thinking: Thinking): Reasoning {
  if (typeof thinking === "object") {
    return "kind" in thinking
      ? thinking
      : Reasoning.on({ budget: { tokens: thinking.budgetTokens } });
  }
  if (thinking === "default") return Reasoning.modelDecides();
  if (thinking === "none") return Reasoning.off();
  if (isEffort(thinking)) return Reasoning.on({ effort: thinking });
  throw new ReasoningError({ message: `unknown thinking level "${thinking}"` });
}

/** How a reasoning setting reads in messages and the startup log. */
export function reasoningLabel(reasoning: Reasoning): string {
  switch (reasoning.kind) {
    case "model-decides":
      return "model decides";
    case "off":
      return "off";
    case "on":
      return `on(${[
        ...(reasoning.effort === undefined ? [] : [`effort ${reasoning.effort}`]),
        ...(reasoning.budget === undefined
          ? []
          : [`budget ${String(reasoning.budget.tokens)} tokens`]),
      ].join(", ")})`;
  }
}
