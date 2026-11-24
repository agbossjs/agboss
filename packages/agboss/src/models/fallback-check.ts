import { priceOf } from "./cost.js";
import {
  modelProviderOf,
  servesModel,
  type KeptModelProviderOptions,
} from "./model-provider.decorator.js";
import type { ModelProblem } from "./problems.js";
import type { ModelUse } from "./uses.js";

/**
 * A provider's fallback must take over every model the workflow uses on it (#202): mapped
 * (`circuitBreakerPolicy.fallbackModels`) to a model the fallback serves, and priced by it when
 * the fallback prices from a table — otherwise a fallback call would resend the primary's model
 * id or be billed at the primary's prices.
 */
export function fallbackProblems(
  use: ModelUse,
  provider: KeptModelProviderOptions,
): readonly ModelProblem[] {
  const { fallback, fallbackModels = {} } = provider.circuitBreakerPolicy;
  if (fallback === undefined) return [];
  const backup = modelProviderOf(fallback);
  const mapped = fallbackModels[use.model];
  const problem = (code: ModelProblem["code"], supported: string): ModelProblem => ({
    code,
    key: use.key,
    value: use.model,
    model: use.model,
    supported,
  });
  if (mapped === undefined || !servesModel(backup, mapped)) {
    const given = mapped === undefined ? "no fallbackModels entry" : `${mapped} is not served`;
    return [
      problem(
        "model.fallback-unmapped",
        `${provider.name} falls back to ${backup.name}: ${given} — map it in circuitBreakerPolicy.fallbackModels`,
      ),
    ];
  }
  if (backup.cost.kind === "from-prices" && priceOf(backup.cost, mapped) === undefined) {
    return [problem("model.fallback-no-price", `${backup.name} has no price for ${mapped}`)];
  }
  return [];
}
