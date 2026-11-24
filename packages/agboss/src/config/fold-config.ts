import type { ApplicationOptions } from "../application/application.js";
import type { EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import type { Class } from "../components/injection.js";
import type { LoadedProfile } from "./config-files.js";
import { deepMerge } from "./deep-merge.js";
import type { ModelProviderOverlay, WorkflowConfig, WorkflowOverlay } from "./overlay-types.js";

/** What the profiles of one workflow fold to: constants merged, its own provider class, prompt texts. */
export interface FoldedWorkflow {
  readonly overlay: WorkflowOverlay;
  readonly modelProvider?: Class | undefined;
  readonly prompts: Readonly<Record<string, string>>;
}

/** The infrastructure classes of an application a profile replaces whole (the last profile that sets one wins). */
export interface ApplicationReplacements {
  readonly storage?: ApplicationOptions["storage"];
  readonly modelProvider?: Class;
  readonly channels?: ApplicationOptions["channels"];
  readonly observers?: ApplicationOptions["observers"];
  readonly healthChecks?: ApplicationOptions["healthChecks"];
}

/** One profile's workflow overlays, as it wrote them: its `"*"` applies before its own workflow keys. */
export interface FoldedLayer {
  /** The profile (`prod`, `base`) the overlays came from, for messages. */
  readonly name: string;
  readonly workflows: Readonly<Record<string, FoldedWorkflow>>;
}

/** The selected profiles layered left to right into one config. */
export interface FoldedConfig {
  /** The profiles the instance runs with, in layering order (`ApplicationContext.profiles`). */
  readonly profiles: readonly string[];
  /** `configureEnv` values, one per `defineEnv`, a later profile winning per key. */
  readonly env: readonly EnvOverrides<EnvContract>[];
  readonly defaults?: unknown;
  readonly modelProviders: Readonly<Record<string, ModelProviderOverlay>>;
  /** Each profile's workflow overlays in layering order: a later profile's wins, `"*"` before the workflow's own within one. */
  readonly layers: readonly FoldedLayer[];
  readonly replacements: ApplicationReplacements;
}

/** The config of a selection no file backs: nothing changes. */
export const unchangedConfig = (profiles: readonly string[]): FoldedConfig => ({
  profiles,
  env: [],
  modelProviders: {},
  layers: [],
  replacements: {},
});

/** `configureEnv` values of every profile as one override per `defineEnv`. */
function envOf(layers: readonly LoadedProfile[]): EnvOverrides<EnvContract>[] {
  const byContract = new Map<EnvContract, Record<string, unknown>>();
  for (const layer of layers) {
    const given = layer.spec.env;
    if (given === undefined) continue;
    for (const override of ([] as EnvOverrides<EnvContract>[]).concat(given)) {
      byContract.set(override.contract, {
        ...byContract.get(override.contract),
        ...override.values,
      });
    }
  }
  return [...byContract].map(([contract, values]) => ({ contract, values }));
}

function providersOf(
  layers: readonly LoadedProfile[],
): Readonly<Record<string, ModelProviderOverlay>> {
  let merged: unknown = {};
  for (const layer of layers) merged = deepMerge(merged, layer.spec.modelProviders ?? {});
  return merged as Record<string, ModelProviderOverlay>;
}

/** The constants of a workflow's config: all but its prompts (read as texts) and its provider (a class). */
const constantsOf = (one: WorkflowConfig): WorkflowOverlay =>
  Object.fromEntries(
    Object.entries(one).filter(([key]) => key !== "prompts" && key !== "modelProvider"),
  );

function layerOf(layer: LoadedProfile): FoldedLayer {
  return {
    name: layer.name,
    workflows: Object.fromEntries(
      Object.entries(layer.spec.workflows ?? {}).map(([name, one]) => [
        name,
        {
          // the prompts are the texts the loader read, not the paths they were written as
          overlay: constantsOf(one),
          modelProvider: one.modelProvider,
          prompts: layer.promptTexts[name] ?? {},
        },
      ]),
    ),
  };
}

/** The last profile's value of a replacement slot. */
function lastOf<TKey extends keyof ApplicationReplacements>(
  layers: readonly LoadedProfile[],
  key: TKey,
): ApplicationReplacements[TKey] {
  return layers.reduce<ApplicationReplacements[TKey]>(
    (found, layer) => layer.spec[key] ?? found,
    undefined,
  );
}

const replacementsOf = (layers: readonly LoadedProfile[]): ApplicationReplacements => {
  const keys = ["storage", "modelProvider", "channels", "observers", "healthChecks"] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = lastOf(layers, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );
};

/** The layers (`base` first, then the selection in order) folded left to right: a later layer wins. */
export function foldedConfigOf(
  profiles: readonly string[],
  layers: readonly LoadedProfile[],
): FoldedConfig {
  let defaults: unknown;
  for (const layer of layers) defaults = deepMerge(defaults, layer.spec.defaults);
  return {
    profiles,
    env: envOf(layers),
    ...(defaults === undefined ? {} : { defaults }),
    modelProviders: providersOf(layers),
    layers: layers.map(layerOf),
    replacements: replacementsOf(layers),
  };
}
