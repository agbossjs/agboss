import { Secret } from "../environments/secret.js";
import { resolveReferences } from "../environments/define-env.js";
import { isDriverOptions, type KeptModelProviderOptions } from "./model-provider.decorator.js";

/**
 * What a driver provider reads (#1313): its key, base URL and headers are `env(…)` / `secret(…)`
 * references in its driver, read from the process at start; a problem names the variable, never a
 * value. A provider never reads `process.env` itself. A transport provider (#385) has none: its
 * class authorises its own calls.
 */

/** Where a provider's settings are read: the process, for the references of its driver. */
export interface ProviderSettingSource {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * One setting of a driver (#1313) with its `env(…)` / `secret(…)` references read from the process;
 * a problem names the variable, never a value. `undefined` when the setting is not given.
 */
function driverSettingOf(
  options: KeptModelProviderOptions,
  setting: string,
  value: unknown,
  source: ProviderSettingSource,
): unknown {
  if (value === undefined) return undefined;
  const resolved = resolveReferences({ [setting]: value }, source.env, `${options.name} driver`);
  return resolved[setting];
}

/** A driver's base URL: its text, or the `env(…)` it names, read from the process. */
const driverBaseUrlOf = (
  options: KeptModelProviderOptions & {
    readonly driver: { readonly settings: { readonly baseUrl: unknown } };
  },
  source: ProviderSettingSource,
): string => {
  const value = driverSettingOf(options, "baseUrl", options.driver.settings.baseUrl, source);
  return typeof value === "string" ? value : "";
};

/** A driver's key: read when `required`; a missing one then fails naming the variable. */
function driverKeyOf(
  options: KeptModelProviderOptions & {
    readonly driver: { readonly settings: { readonly apiKey?: unknown } };
  },
  source: ProviderSettingSource,
  required: boolean,
): string | undefined {
  try {
    const value = driverSettingOf(options, "apiKey", options.driver.settings.apiKey, source);
    return value instanceof Secret ? value.reveal() : undefined;
  } catch (error) {
    if (required) throw error;
    return undefined;
  }
}

/** A driver's headers with their references read; a header whose optional secret is unset is left out. */
function driverHeadersOf(
  options: KeptModelProviderOptions & {
    readonly driver: { readonly settings: { readonly headers?: unknown } };
  },
  source: ProviderSettingSource,
): Readonly<Record<string, string>> | undefined {
  const headers = options.driver.settings.headers;
  if (headers === undefined) return undefined;
  const resolved = driverSettingOf(options, "headers", headers, source) as Readonly<
    Record<string, unknown>
  >;
  return Object.fromEntries(
    Object.entries(resolved).flatMap(([name, value]) => {
      if (value instanceof Secret) return [[name, value.reveal()] as const];
      return typeof value === "string" ? [[name, value] as const] : [];
    }),
  );
}

/** The headers its driver adds to every request (#1313); none for a transport provider. */
export function providerHeadersOf(
  options: KeptModelProviderOptions,
  source: ProviderSettingSource,
): Readonly<Record<string, string>> | undefined {
  return isDriverOptions(options) ? driverHeadersOf(options, source) : undefined;
}

/** The provider's key; `undefined` for one without a key, or a missing one when not `required`. */
export function providerKeyOf(
  options: KeptModelProviderOptions,
  source: ProviderSettingSource,
  required: boolean,
): string | undefined {
  // a transport provider (#385) has no key: its class authorises its own calls
  return isDriverOptions(options) ? driverKeyOf(options, source, required) : undefined;
}

/** The provider's base URL: its driver's; a transport provider (#385) has none. */
export function providerBaseUrlOf(
  options: KeptModelProviderOptions,
  source: ProviderSettingSource,
): string {
  return isDriverOptions(options) ? driverBaseUrlOf(options, source) : "";
}
