import type { AgentsConfigOf } from "../config/types.js";
import type { ModelPricing } from "./model-pricing.js";
import { costLabel, priceOf } from "./cost.js";
import { promptCachingLabel } from "./prompt-caching.js";
import { reasoningLabel } from "./reasoning.js";
import type { ModelProviderType } from "./model-provider.decorator.js";
import { ModelKind } from "./model-kind.js";
import { ModelProviderDirectory } from "./resolve.js";
import type { ModelUse } from "./uses.js";

/** The directory of an application's model providers (`AssembledWorkflow.modelProviders`). */
export const directoryOf = (providers: readonly ModelProviderType[]): ModelProviderDirectory =>
  ModelProviderDirectory.of(providers);

/** The pricing of an application's model providers. */
export function modelPricingOf(directory: ModelProviderDirectory): ModelPricing {
  return (settings) => {
    if (settings.modelProvider === undefined) return settings;
    // the provider its cascade resolved (a chat or a decisions one), not one that lists the model (#1313)
    const provider = directory.named(settings.modelProvider);
    if (provider === undefined) return settings;
    const { cost } = provider.options;
    if (cost === undefined) return { ...settings, unpriced: true };
    const price = priceOf(cost, settings.model);
    return price === undefined ? settings : { ...settings, price };
  };
}

/** The config with every chat model priced by its provider's table. */
export function withProviderPrices(
  config: AgentsConfigOf<string>,
  directory: ModelProviderDirectory,
): AgentsConfigOf<string> {
  const priced = modelPricingOf(directory);
  const router = config.defaults.router;
  return {
    ...config,
    // the default router (guards, `ROUTER_FACTORY`, eval) on a chat model is priced like any other use
    ...(router?.kind === "llm" ? { defaults: { ...config.defaults, router: priced(router) } } : {}),
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [name, priced(agent)]),
    ),
    ...(config.memories === undefined
      ? {}
      : {
          memories: Object.fromEntries(
            Object.entries(config.memories).map(([name, compaction]) => [
              name,
              compaction.model === undefined
                ? compaction
                : { ...compaction, model: priced(compaction.model) },
            ]),
          ),
        }),
    ...(config.judges === undefined
      ? {}
      : {
          judges: Object.fromEntries(
            Object.entries(config.judges).map(([name, judge]) => [name, priced(judge)]),
          ),
        }),
  };
}

/** One line per model use for the startup log: provider, reasoning and caching, and where they come from. */
export function modelSummaryOf(
  uses: readonly ModelUse[],
  directory: ModelProviderDirectory,
): readonly string[] {
  return uses.flatMap((use) => {
    const resolution = directory.resolve(use);
    if (resolution.kind === "problem") return [];
    const provider = resolution.provider.options;
    const inherited = ` (inherited from ${provider.name})`;
    const settings = use.settings;
    const chat =
      use.purpose === ModelKind.Decisions || settings === undefined
        ? []
        : [
            `reasoning ${reasoningLabel(settings.reasoning ?? provider.reasoning)}${settings.reasoning === undefined ? inherited : ""}`,
            `caching ${promptCachingLabel(settings.promptCaching ?? provider.promptCaching)}${settings.promptCaching === undefined ? inherited : ""}`,
          ];
    return [
      [
        `${use.key}  ${use.model}`,
        `provider ${provider.name}`,
        ...chat,
        provider.cost === undefined ? "unpriced" : costLabel(provider.cost),
      ].join(" · "),
    ];
  });
}
