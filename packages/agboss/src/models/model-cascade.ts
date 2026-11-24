import type { AgentsConfigOf, ModelSettings } from "../config/types.js";
import type { Class } from "../components/injection.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import {
  isDriverOptions,
  isModelProviderClass,
  modelProviderOf,
  type KeptModelProviderOptions,
  type ModelProviderType,
} from "./model-provider.decorator.js";

/**
 * The model cascade (#1313): a component's model is served by the `@ModelProvider` it names
 * (`modelProvider`), else its workflow's, else its application's — and the name it gives (`"fast"`,
 * none) is a role the provider maps to the vendor's model name. Resolved once, at assembly, into the
 * config: `model` is then the vendor's name and `modelProvider` the provider's `name`.
 */

/** The role a component that names no model asks its provider for: `models.default`, else `model`. */
export const DEFAULT_MODEL_ALIAS = "default";

/** The levels a component's provider comes from, nearest first: its workflow, its application. */
export interface ModelCascade {
  readonly workflow?: Class | undefined;
  readonly application?: Class | undefined;
  /** The providers the workflow's components name themselves (an agent's `modelProvider`). */
  readonly components?: readonly (Class | undefined)[];
}

/**
 * The vendor's model name for what a component asked: a role the provider's `models` maps, the
 * provider's `model` for the default role, any other name as written. `undefined`: the default role
 * of a provider that has neither `model` nor `models.default`.
 */
export function modelNamedBy(
  options: KeptModelProviderOptions,
  requested: string | undefined,
): string | undefined {
  const asked = requested ?? DEFAULT_MODEL_ALIAS;
  if (!isDriverOptions(options)) return asked === DEFAULT_MODEL_ALIAS ? undefined : asked;
  const mapped = options.models?.[asked];
  if (mapped !== undefined) return mapped;
  if (asked === DEFAULT_MODEL_ALIAS) return options.model;
  return asked;
}

/** One provider class, or why it is none. */
const providerOptionsOf = (cls: Class): KeptModelProviderOptions | undefined =>
  isModelProviderClass(cls) ? modelProviderOf(cls) : undefined;

/** The `@ModelProvider` classes a workflow's cascade and its components name, each once. */
export const referencedModelProvidersOf = (cascade: ModelCascade): readonly ModelProviderType[] => {
  const named = [cascade.workflow, cascade.application, ...(cascade.components ?? [])].flatMap(
    (cls) => (cls === undefined || !isModelProviderClass(cls) ? [] : [cls]),
  );
  return [...new Set(named)];
};

/** What the cascade's own levels and the components' own providers found wrong, all at once. */
interface Resolver {
  readonly violations: RuleViolation[];
  readonly byName: ReadonlyMap<string, KeptModelProviderOptions>;
  readonly inherited: KeptModelProviderOptions | undefined;
  readonly workflow: string;
}

/** A model use with its provider and model name resolved; unchanged when no provider is in its cascade. */
function resolvedUse<
  T extends {
    readonly model: string;
    readonly modelProvider?: string | undefined;
    readonly unpriced?: true | undefined;
  },
>(use: T, key: string, resolver: Resolver, isImplicitModel = false): T {
  const options =
    use.modelProvider === undefined ? resolver.inherited : resolver.byName.get(use.modelProvider);
  if (options === undefined) return use;
  const model = modelNamedBy(options, isImplicitModel ? undefined : use.model);
  if (model === undefined) {
    resolver.violations.push(
      violation(
        "model.missing",
        `${resolver.workflow} ${key}: names no model and ${options.name} has no model or models.default — set model on the component or on the provider`,
        [resolver.workflow],
      ),
    );
    return use;
  }
  return {
    ...use,
    model,
    modelProvider: options.name,
    ...(options.cost === undefined ? { unpriced: true as const } : {}),
  };
}

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

/** The compactions and judges of the config with their models resolved. */
function withResolvedSettings(
  config: AgentsConfigOf<string>,
  resolver: Resolver,
): Pick<AgentsConfigOf<string>, "agents" | "judges" | "compactions"> {
  const settingsOf = (settings: ModelSettings, key: string): ModelSettings =>
    resolvedUse(settings, key, resolver);
  return {
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [
        name,
        resolvedUse(agent, `agents.${name}`, resolver),
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
    ...(config.compactions === undefined
      ? {}
      : {
          compactions: Object.fromEntries(
            Object.entries(config.compactions).map(([name, compaction]) => [
              name,
              compaction.model === undefined
                ? compaction
                : { ...compaction, model: settingsOf(compaction.model, `compactions.${name}`) },
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
): AgentsConfigOf<string> {
  const byName = new Map(
    referencedModelProvidersOf(cascade).map((cls) => [
      modelProviderOf(cls).name,
      modelProviderOf(cls),
    ]),
  );
  const levelOf = cascade.workflow ?? cascade.application;
  const inherited = levelOf === undefined ? undefined : providerOptionsOf(levelOf);
  const resolver: Resolver = {
    violations: notProviders(config, cascade),
    byName,
    inherited,
    workflow: config.name,
  };
  const resolved: AgentsConfigOf<string> = {
    ...config,
    ...withResolvedSettings(config, resolver),
    defaults: {
      ...config.defaults,
      ...(config.defaults.router === undefined
        ? {}
        : { router: resolvedUse(config.defaults.router, "defaults.router", resolver) }),
    },
  };
  if (resolver.violations.length > 0) throw new GraphRuleError({ violations: resolver.violations });
  return resolved;
}
