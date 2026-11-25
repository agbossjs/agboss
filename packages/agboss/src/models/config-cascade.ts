import type { AgentsConfigOf, ModelSettings } from "../config/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { OMITTED_MODEL, providerOptionsOf, type ModelCascade } from "./model-cascade.js";
import { modelResolverOf, type ModelResolver } from "./model-resolver.js";

/**
 * The model cascade (#1313) on the config: each agent, judge and compaction model resolved through
 * its provider, its workflow's, its application's.
 */

/** The workflow's cascade levels that are no `@ModelProvider` class. */
const notProviders = (config: AgentsConfigOf<string>, cascade: ModelCascade): RuleViolation[] =>
  [cascade.workflow, cascade.application].flatMap((cls) =>
    cls === undefined || providerOptionsOf(cls) !== undefined
      ? []
      : [
          violation(
            "model.missing-provider",
            `${config.name}: modelProvider ${cls.name} is not a @ModelProvider class`,
            [config.name],
          ),
        ],
  );

/** Whether a config model names nothing (`OMITTED_MODEL`). */
const isOmitted = (settings: ModelSettings): boolean => settings.model === OMITTED_MODEL;

/** The agents, judges and compactions of the config with their models resolved. */
function withResolvedSettings(
  config: AgentsConfigOf<string>,
  resolver: ModelResolver,
): Pick<AgentsConfigOf<string>, "agents" | "judges" | "memories"> {
  const settingsOf = <T extends ModelSettings>(settings: T, key: string): T =>
    resolver.use(settings, key, { isOmitted: isOmitted(settings), isRequired: true });
  return {
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [
        name,
        settingsOf(agent, `agents.${name}`),
      ]),
    ),
    ...(config.judges === undefined
      ? {}
      : {
          judges: Object.fromEntries(
            Object.entries(config.judges).map(([name, judge]) => [
              name,
              settingsOf(judge, `judges.${name}`),
            ]),
          ),
        }),
    ...(config.memories === undefined
      ? {}
      : {
          memories: Object.fromEntries(
            Object.entries(config.memories).map(([name, compaction]) => [
              name,
              compaction.model === undefined
                ? compaction
                : { ...compaction, model: settingsOf(compaction.model, `memories.${name}`) },
            ]),
          ),
        }),
  };
}

/**
 * The config with every model resolved through its cascade: each agent, judge and compaction model,
 * and the default router. A component with no provider in its cascade keeps its model as written
 * (the older providers' `serves` resolve it). A model that resolves to nothing is `[model.missing]`.
 */
export function withModelProviders(
  config: AgentsConfigOf<string>,
  cascade: ModelCascade,
  shared?: ModelResolver,
): AgentsConfigOf<string> {
  const resolver = shared ?? modelResolverOf(config.name, cascade);
  resolver.violations.push(...notProviders(config, cascade));
  const resolved: AgentsConfigOf<string> = {
    ...config,
    ...withResolvedSettings(config, resolver),
    defaults: {
      ...config.defaults,
      ...(config.defaults.router === undefined
        ? {}
        : { router: resolver.use(config.defaults.router, "defaults.router") }),
    },
  };
  if (shared === undefined) resolver.check();
  return resolved;
}
