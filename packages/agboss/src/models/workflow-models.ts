import type { AgentsConfigOf, ModelSettings } from "../config/types.js";
import { costLabel, priceOf } from "./cost.js";
import { DecisionsModelProvider } from "./jev.provider.js";
import { OpenRouterModelProvider } from "./openrouter-model.provider.js";
import { promptCachingLabel } from "./prompt-caching.js";
import { reasoningLabel } from "./reasoning.js";
import type { ModelProviderType } from "./model-provider.decorator.js";
import { ModelProviderDirectory, ModelPurpose } from "./resolve.js";
import type { ModelUse } from "./uses.js";

/**
 * An application that lists no `@ModelProvider` gets these: OpenRouter for chat, the Decisions API
 * for decision models. One listed makes the list complete — these are not added next to it (#266).
 */
export const DEFAULT_MODEL_PROVIDERS = [OpenRouterModelProvider, DecisionsModelProvider] as const;

/** The directory of an application's model providers (`AssembledWorkflow.modelProviders`). */
export const directoryOf = (providers: readonly ModelProviderType[]): ModelProviderDirectory =>
  ModelProviderDirectory.of(providers);

/** A chat model's settings with the price from its provider's table when it has none of its own. */
function priced<T extends ModelSettings>(settings: T, directory: ModelProviderDirectory): T {
  if (settings.price !== undefined) return settings;
  const resolution = directory.resolve({
    key: settings.model,
    model: settings.model,
    purpose: ModelPurpose.Chat,
  });
  if (resolution.kind === "problem") return settings;
  const price = priceOf(resolution.provider.options.cost, settings.model);
  return price === undefined ? settings : { ...settings, price };
}

/** The config with every chat model priced by its provider's table where it sets no price itself. */
export function withProviderPrices(
  config: AgentsConfigOf<string>,
  directory: ModelProviderDirectory,
): AgentsConfigOf<string> {
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [name, priced(agent, directory)]),
    ),
    ...(config.compaction === undefined
      ? {}
      : {
          compaction: { ...config.compaction, model: priced(config.compaction.model, directory) },
        }),
    ...(config.judges === undefined
      ? {}
      : {
          judges: Object.fromEntries(
            Object.entries(config.judges).map(([name, judge]) => [name, priced(judge, directory)]),
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
      use.purpose === ModelPurpose.Decision || settings === undefined
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
        costLabel(provider.cost),
      ].join(" · "),
    ];
  });
}
