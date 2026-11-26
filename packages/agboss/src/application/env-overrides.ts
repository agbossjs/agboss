import type { BuildOptions } from "../app/app-deps.js";
import { resolveEnv, type EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import type { AssembledApplication } from "./assemble.js";

/** The overrides of each `defineEnv`, one per contract: a later layer wins per key. */
function mergedByContract(
  layers: readonly EnvOverrides<EnvContract>[],
): readonly EnvOverrides<EnvContract>[] {
  const byContract = new Map<EnvContract, Record<string, unknown>>();
  for (const layer of layers)
    byContract.set(layer.contract, { ...byContract.get(layer.contract), ...layer.values });
  return [...byContract].map(([contract, values]) => ({ contract, values }));
}

/**
 * The build options with the `configureEnv` values: the selected profiles' first, a test's
 * (`options.envOverrides`) over them. A `defineEnv` dictionary resolves against the instance's
 * `processEnv` (default `process.env`) with the override in place of a key's own (secrets are
 * `Secret`s either way), and a dictionary nothing touches resolves as it always did.
 */
export function withEnvOverrides(
  options: BuildOptions,
  profiled: AssembledApplication["envOverrides"],
): BuildOptions {
  const overrides = mergedByContract([...profiled, ...(options.envOverrides ?? [])]);
  // the process the instance is given is the one its `defineEnv` values are read from — never the real one behind its back
  if (overrides.length === 0 && options.processEnv === undefined) return options;
  const { container } = options;
  const resolve = envResolverOf(overrides, options.processEnv ?? process.env);
  const envOf = (contract: EnvContract): unknown =>
    container?.envOf?.(contract) ?? resolve(contract);
  return { ...options, container: { ...container, envOf } };
}

/**
 * What a container's `envOf` is: the values of a `defineEnv` read from `processEnv`, with the
 * `overrides` in place of the process's for their keys (a unit runner's `env`, a test's).
 */
export function envResolverOf(
  overrides: readonly EnvOverrides<EnvContract>[],
  processEnv: NodeJS.ProcessEnv = process.env,
): (contract: EnvContract) => unknown {
  const merged = mergedByContract(overrides);
  return (contract) =>
    resolveEnv(
      contract,
      processEnv,
      merged.find((one) => one.contract === contract),
    );
}

/** What a test's `env` option takes: one `configureEnv(appEnv, { … })` or a list of them. */
export type TestEnvOverrides = EnvOverrides<EnvContract> | readonly EnvOverrides<EnvContract>[];

/** A test's `env` option as a list. */
export const envOverridesOf = (
  given: TestEnvOverrides | undefined,
): readonly EnvOverrides<EnvContract>[] =>
  given === undefined ? [] : ([] as EnvOverrides<EnvContract>[]).concat(given);
