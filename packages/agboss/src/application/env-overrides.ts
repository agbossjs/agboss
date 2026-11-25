import type { BuildOptions } from "../app/app-deps.js";
import { resolveEnv } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * The build options with the profiles' `configureEnv` values: a `defineEnv` dictionary resolves
 * against the process variables with the profile's value in place of a key's own (secrets are
 * `Secret`s either way), and a dictionary no profile touches resolves as it always did.
 */
export function withEnvOverrides(
  options: BuildOptions,
  overrides: AssembledApplication["envOverrides"],
): BuildOptions {
  if (overrides.length === 0) return options;
  const processEnv = options.processEnv ?? process.env;
  const { container } = options;
  const envOf = (contract: EnvContract): unknown =>
    container?.envOf?.(contract) ??
    resolveEnv(
      contract,
      processEnv,
      overrides.find((one) => one.contract === contract),
    );
  return { ...options, container: { ...container, envOf } };
}
