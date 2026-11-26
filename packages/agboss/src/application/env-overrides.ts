import type { BuildOptions } from "../app/app-deps.js";
import { processEnvWith, resolveEnv, type EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import { invalidValueError } from "../environments/environment-rules.js";
import { OptionalSecretReference, Secret } from "../environments/secret.js";
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

/** A secret comes from its process variable only: no profile and no test's `env` can put one in (#1324b). */
function assertNoSecretOverrides(layers: readonly EnvOverrides<EnvContract>[]): void {
  for (const { contract, values } of layers) {
    const secrets = Object.keys(values).filter((key) => {
      const reference: unknown = Reflect.get(contract, key);
      return reference instanceof Secret || reference instanceof OptionalSecretReference;
    });
    if (secrets.length > 0)
      throw invalidValueError(
        `configureEnv sets ${secrets.join(", ")}, a secret — a secret comes from its process variable (processEnv), never from a profile or an override`,
      );
  }
}

/**
 * The build options with the `configureEnv` values: the selected profiles' first, a test's
 * (`options.envOverrides`) over them. They ride on the instance's `processEnv` (default
 * `process.env`), so every reference — a `defineEnv` read through `deps: [appEnv]`, a storage
 * driver's, a model provider's, the mesh's, an A2A agent's, an MCP server's — resolves to the
 * override, never to the variable or its default behind the override's back. A secret override
 * comes from a test only: a profile cannot carry one (`defineConfig` refuses it).
 */
export function withEnvOverrides(
  options: BuildOptions,
  profiled: AssembledApplication["envOverrides"],
): BuildOptions {
  assertNoSecretOverrides([...profiled, ...(options.envOverrides ?? [])]);
  const overrides = mergedByContract([...profiled, ...(options.envOverrides ?? [])]);
  const processEnv = processEnvWith(options.processEnv ?? process.env, overrides);
  if (processEnv === (options.processEnv ?? process.env) && options.processEnv === undefined)
    return options;
  const { container } = options;
  const envOf = (contract: EnvContract): unknown =>
    container?.envOf?.(contract) ?? resolveEnv(contract, processEnv);
  return { ...options, processEnv, container: { ...container, envOf } };
}

/**
 * What a container's `envOf` is: the values of a `defineEnv` read from `processEnv`, with the
 * `overrides` in place of the process's for their keys (a unit runner's `env`, a test's).
 */
export function envResolverOf(
  overrides: readonly EnvOverrides<EnvContract>[],
  processEnv: NodeJS.ProcessEnv = process.env,
): (contract: EnvContract) => unknown {
  assertNoSecretOverrides(overrides);
  const carried = processEnvWith(processEnv, mergedByContract(overrides));
  return (contract) => resolveEnv(contract, carried);
}

/** What a test's `env` option takes: one `configureEnv(appEnv, { … })` or a list of them. */
export type TestEnvOverrides = EnvOverrides<EnvContract> | readonly EnvOverrides<EnvContract>[];

/** A test's `env` option as a list. */
export const envOverridesOf = (
  given: TestEnvOverrides | undefined,
): readonly EnvOverrides<EnvContract>[] =>
  given === undefined ? [] : ([] as EnvOverrides<EnvContract>[]).concat(given);
