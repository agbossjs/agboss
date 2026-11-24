import { priceOf } from "./cost.js";
import { fallbackHopsOf } from "./fallback-chain.js";
import type { ModelInputKind } from "./content.js";
import { sharedInputs } from "./capabilities.js";
import {
  isDriverOptions,
  servesModel,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import type { ModelProblem } from "./problems.js";
import { registeredOf, type RegisteredModelProvider } from "./resolve.js";
import type { ModelUse } from "./uses.js";

/**
 * Every provider of a provider's fallback chain must take over the model the workflow uses on it
 * (#202, #1313): serve the model it is mapped to (`fallback.models`, a role it shares, else the same
 * name), and price it when it prices from a table — otherwise a fallback call would send a model the
 * hop does not serve or be billed at the primary's prices.
 */
export function fallbackProblems(
  use: ModelUse,
  provider: RegisteredModelProvider,
): readonly ModelProblem[] {
  return fallbackHopsOf(provider.type, use.model).flatMap((hop) => {
    const problem = (code: ModelProblem["code"], supported: string): ModelProblem => ({
      code,
      key: use.key,
      value: use.model,
      model: use.model,
      supported,
    });
    const { options, model } = hop;
    // a driver provider serves any model its server knows (the server's `/models` says at start)
    if (!isDriverOptions(options) && !servesModel(options, model)) {
      return [
        problem(
          "model.fallback-unmapped",
          `${provider.options.name} falls back to ${options.name}: ${model} is not served — map it in fallback.models`,
        ),
      ];
    }
    if (options.cost?.kind === "from-prices" && priceOf(options.cost, model) === undefined) {
      return [problem("model.fallback-no-price", `${options.name} has no price for ${model}`)];
    }
    return [];
  });
}

/** What checking one use found: its problems, and the kinds of input its model says it takes. */
interface HopResult {
  readonly problems: readonly ModelProblem[];
  readonly inputs?: readonly ModelInputKind[];
}

/**
 * A use checked on every hop of its provider's fallback chain, as the model each hop is asked for
 * (#1313): only what the component set stays (the hop's own provider decides its defaults and its
 * prices); the problems of every hop, and the input kinds all of them take.
 */
export async function fallbackUseResults(
  use: ModelUse,
  provider: RegisteredModelProvider,
  checkHop: (hopUse: ModelUse, registered: RegisteredModelProvider) => Promise<HopResult>,
): Promise<HopResult> {
  const results: HopResult[] = [];
  for (const hop of fallbackHopsOf(provider.type, use.model)) {
    const settings =
      use.settings === undefined ? {} : { settings: { ...use.settings, price: undefined } };
    const hopUse: ModelUse = {
      ...use,
      model: hop.model,
      modelProvider: hop.options.name,
      ...settings,
    };
    results.push(await checkHop(hopUse, registeredOf(hop.cls as ModelProviderType)));
  }
  const inputs = results.map((each) => each.inputs).reduce(sharedInputs, undefined);
  return {
    problems: results.flatMap((each) => each.problems),
    ...(inputs === undefined ? {} : { inputs }),
  };
}
