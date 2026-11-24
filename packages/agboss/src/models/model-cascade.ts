import type { Class } from "../components/injection.js";
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

/** What a profile changes of one provider's model names. */
export interface ProviderOverlay {
  readonly model?: string | undefined;
  readonly models?: Readonly<Record<string, string>> | undefined;
}

/** A provider's options with a profile's model names over its own (a driver provider only). */
export function overlaidProvider(
  options: KeptModelProviderOptions,
  overlay: ProviderOverlay | undefined,
): KeptModelProviderOptions {
  if (overlay === undefined || !isDriverOptions(options)) return options;
  return {
    ...options,
    ...(overlay.model === undefined ? {} : { model: overlay.model }),
    models: { ...options.models, ...overlay.models },
  };
}

/** The role a component that names no model asks its provider for: `models.default`, else `model`. */
export const DEFAULT_MODEL_ALIAS = "default";

/**
 * What the config holds for a component that named no model, until the cascade resolves it: not a
 * role a developer can write, so a component that names `"default"` is told apart from one that names
 * nothing (only the latter takes a level's `defaults.models.model`).
 */
export const OMITTED_MODEL = "(no model named)";

/**
 * What a profile changes of one model-backed component, by its use key (`judges.<name>`,
 * `routers.<name>`, `arbiters.<name>`, `guardrails.<name>`, `pii.<name>`, `replyInterpreters.<name>`):
 * its model name, and the `@ModelProvider` that serves it — a class (a `.config.ts`) or its `name`.
 */
export interface ComponentModelOverride {
  readonly model?: string | undefined;
  readonly modelProvider?: string | Class | undefined;
}

/** The overrides of one workflow's components, and the keys the assembly reached (a key left over is a typo). */
export interface ComponentModelOverrides {
  /** The `@ModelProvider` classes of the application, which an override can name by `name`. */
  readonly providers: readonly Class[];
  readonly byKey: ReadonlyMap<string, ComponentModelOverride>;
  readonly reached: Set<string>;
}

/** The levels a component's provider comes from, nearest first: its workflow, its application. */
export interface ModelCascade {
  readonly workflow?: Class | undefined;
  readonly application?: Class | undefined;
  /** The providers the workflow's components name themselves (an agent's, a router's, a guardrail's `modelProvider`). */
  readonly components?: readonly (Class | undefined)[];
  /**
   * `defaults.models.model` of each level (#1313): the model a component that names none takes, a
   * role of its provider or a vendor name. A level's applies only when the provider the component
   * resolves to is that level's provider.
   */
  /**
   * What the selected profiles (`src/config/`) change of each provider, by its `name`: the model it
   * serves and its role names. Applied to a provider's options as the cascade reads them — the
   * decorator's own options are never touched.
   */
  readonly providerOverlays?: Readonly<Record<string, ProviderOverlay>> | undefined;
  /** What the selected profiles change of single components' models, by use key. */
  readonly componentModels?: ComponentModelOverrides | undefined;
  readonly models?: {
    readonly workflow?: string | undefined;
    readonly application?: string | undefined;
  };
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
export const providerOptionsOf = (cls: Class): KeptModelProviderOptions | undefined =>
  isModelProviderClass(cls) ? modelProviderOf(cls) : undefined;

/** The `@ModelProvider` classes a workflow's cascade and its components name, each once. */
export const referencedModelProvidersOf = (cascade: ModelCascade): readonly ModelProviderType[] => {
  const overridden = [...(cascade.componentModels?.byKey.values() ?? [])].map(
    (override) => override.modelProvider,
  );
  const named = [
    cascade.workflow,
    cascade.application,
    ...(cascade.components ?? []),
    ...(cascade.componentModels?.providers ?? []),
    ...overridden,
  ].flatMap((cls) => (cls === undefined || !isModelProviderClass(cls) ? [] : [cls]));
  return [...new Set(named)];
};

/**
 * The default model level of a component that names none: its workflow's `defaults.models.model`
 * when the provider it resolves to is the workflow's (its own, else its application's), else its
 * application's when that is the application's provider. A level whose provider differs is skipped,
 * so an application-wide alias never names a model of another provider.
 */
export function levelModelOf(cascade: ModelCascade, resolved: Class): string | undefined {
  const { workflow, application, models } = cascade;
  if (models?.workflow !== undefined && resolved === (workflow ?? application))
    return models.workflow;
  if (models?.application !== undefined && resolved === application) return models.application;
  return undefined;
}
