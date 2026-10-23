import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { isResolvedSecret, Secret, variableOfSecret } from "../environments/secret.js";
import { VariableReference } from "../environments/variables.js";
import type { Environment } from "../flow/generated-types.js";
import { isHttpProvider, type ModelProviderOptions } from "./model-provider.decorator.js";

/**
 * What a provider reads from the application's typed environment (#266 S73 c): its key — `apiKey`
 * names a `Secret` field (`openRouterApiKey: secret("OPENROUTER_API_KEY")`) — and, when
 * `baseUrlField` names one, its base URL (`openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")`;
 * unset → the decorator's `baseUrl`, so the field repeats no default — #266 S87).
 * Both are read from `applicationContext.environment` at start; a value of an environment passed
 * as written (not resolved yet) takes its own variable from the process — the only place a process
 * variable is read. A provider never reads `process.env` itself.
 */

/** Where a provider's settings are read: the application's environment, the process for its references. */
export interface ProviderSettingSource {
  readonly environment: Environment;
  readonly env: NodeJS.ProcessEnv;
}

/** A variable's value: unset or empty is no value. */
const variableIn = (env: NodeJS.ProcessEnv, variable: string): string | undefined => {
  const raw = env[variable];
  return raw === undefined || raw === "" ? undefined : raw;
};

/** A secret's value: resolved, else its variable in the process. */
const secretValueOf = (value: Secret, env: NodeJS.ProcessEnv): string | undefined =>
  isResolvedSecret(value) ? value.reveal() : variableIn(env, variableOfSecret(value));

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

/** The provider's key; `undefined` for one without a key, or a missing one when not `required`. */
export function providerKeyOf(
  options: ModelProviderOptions,
  source: ProviderSettingSource,
  required: boolean,
): string | undefined {
  // a transport provider (#385) has no key: its class authorises its own calls
  const field = isHttpProvider(options) ? options.apiKey : undefined;
  if (field === undefined) return undefined;
  const value: unknown = Reflect.get(source.environment, field);
  const key = value instanceof Secret ? secretValueOf(value, source.env) : undefined;
  if (key !== undefined) return key;
  return required ? missingKey(options, field, value) : undefined;
}

/** A text field's value: a string, else an `env(…)` reference as written (its variable, its default if any). */
function textValueOf(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (!(value instanceof VariableReference)) return undefined;
  const fallback = typeof value.fallback === "string" ? value.fallback : undefined;
  return variableIn(env, value.variable) ?? fallback;
}

/**
 * The provider's base URL: the environment's `baseUrlField` when it names one that is set, else
 * `baseUrl` — so an application whose environment does not declare the field uses the default.
 */
export function providerBaseUrlOf(
  options: ModelProviderOptions,
  source: ProviderSettingSource,
): string {
  if (!isHttpProvider(options)) return ""; // a transport provider (#385) has no base URL
  const field = options.baseUrlField;
  if (field === undefined) return options.baseUrl;
  return textValueOf(Reflect.get(source.environment, field), source.env) ?? options.baseUrl;
}
