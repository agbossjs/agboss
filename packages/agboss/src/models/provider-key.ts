import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { isResolvedSecret, Secret, variableOfSecret } from "../environments/secret.js";
import type { Environment } from "../flow/generated-types.js";
import type { ModelProviderOptions } from "./model-provider.decorator.js";

/**
 * A provider's key comes from the application's typed environment (#266 S73 c, #261): `apiKey`
 * names a `Secret` field of the contract (`openRouterApiKey: secret("OPENROUTER_API_KEY")` in an
 * environment), read from `applicationContext.environment` when the app starts. A secret not
 * resolved yet (an environment object passed as written) takes its own variable from the process —
 * the only place a secret comes from. A missing one fails the start when the provider will be called.
 */

/** Why a key cannot be read: the field is unset, or it is not a `Secret`. */
function missingKey(options: ModelProviderOptions, field: string, value: unknown): never {
  const why =
    value === undefined
      ? `the environment has no ${field}`
      : `${field} is not a Secret — set it with secret("…")`;
  throw new EnvironmentError(
    EnvironmentErrorCode.MissingVariables,
    `${options.name} reads its key from the application's environment: ${why} — declare ${field}: Secret in the environment contract and set ${field}: secret("…") in each environment that calls it`,
  );
}

/** A secret's value: resolved, else its variable in the process; `undefined` when unset or empty. */
function secretValueOf(value: Secret, processEnv: NodeJS.ProcessEnv): string | undefined {
  if (isResolvedSecret(value)) return value.reveal();
  const raw = processEnv[variableOfSecret(value)];
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Where a provider's key is read: the application's environment, the process for its secrets. */
export interface KeySource {
  readonly environment: Environment;
  readonly env: NodeJS.ProcessEnv;
}

/** The provider's key; `undefined` for one without a key, or a missing one when not `required`. */
export function providerKeyOf(
  options: ModelProviderOptions,
  source: KeySource,
  required: boolean,
): string | undefined {
  const field = options.apiKey;
  if (field === undefined) return undefined;
  const value: unknown = Reflect.get(source.environment, field);
  const key = value instanceof Secret ? secretValueOf(value, source.env) : undefined;
  if (key !== undefined) return key;
  return required ? missingKey(options, field, value) : undefined;
}
