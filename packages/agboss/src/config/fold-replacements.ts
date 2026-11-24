import type { LoadedProfile } from "./config-files.js";
import type { ApplicationReplacements } from "./fold-config.js";

/**
 * The last profile's value of a replacement slot. `channels` and `mesh` also hold a record of settings
 * (a shelf): only a list of classes, a class, replaces — the slot and the shelf fold independently.
 */
function lastOf<TKey extends keyof ApplicationReplacements>(
  layers: readonly LoadedProfile[],
  key: TKey,
): ApplicationReplacements[TKey] {
  const isReplacement = (value: unknown): boolean =>
    key === "channels" ? Array.isArray(value) : key === "mesh" ? typeof value === "function" : true;
  return layers.reduce<ApplicationReplacements[TKey]>((found, layer) => {
    const value: unknown = layer.spec[key];
    return value !== undefined && isReplacement(value)
      ? (value as ApplicationReplacements[TKey])
      : found;
  }, undefined);
}

export const replacementsOf = (layers: readonly LoadedProfile[]): ApplicationReplacements => {
  const keys = ["storage", "modelProvider", "channels", "mesh", "healthChecks"] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = lastOf(layers, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );
};
