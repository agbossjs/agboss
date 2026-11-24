import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { OptionalSecretReference, variableOfSecretRef } from "../environments/secret.js";
import type { Environment } from "../flow/generated-types.js";
import type { FingerprintKeys } from "../infrastructure/fenced-effect-key.js";
import type { AssembledApplication } from "./assemble.js";
import type { AssembledKeyFields } from "./assembled-keys.js";
import { assertKeyVariablesApart } from "./key-variables.js";

/**
 * The application's idempotency keys (#825, #1317, `@DatabaseStorage({ idempotencySecret,
 * previousIdempotencySecret })`): read when the app starts — the same on every instance, used only
 * for business-key fingerprints. Never the PII key, never a
 * provider's: rotating one of those leaves every stored fingerprint as it was.
 */

/** The idempotency key a test's fingerprints are made with (`testWith`, the unit runners). */
export const TEST_IDEMPOTENCY_KEY = "agboss-test-idempotency-key";

/** The previous idempotency key a test gets when its variable is not set: another one. */
export const TEST_PREVIOUS_IDEMPOTENCY_KEY = "agboss-test-previous-idempotency-key";

/** A test's idempotency keys (`testWith`): a field with no value in the test's environment gets them. */
export const TEST_IDEMPOTENCY_KEYS: FingerprintKeys = Object.freeze({
  current: TEST_IDEMPOTENCY_KEY,
  previous: TEST_PREVIOUS_IDEMPOTENCY_KEY,
});

/** The value of a `secret(…)` the storage names: its variable, or the test's key; else the start fails. */
function storageSecretOf(
  application: string,
  option: string,
  ref: SecretRef | OptionalSecretRef,
  env: NodeJS.ProcessEnv,
  fallback: string | undefined,
): string | undefined {
  const variable = variableOfSecretRef(ref);
  const raw = env[variable];
  if (raw !== undefined && raw !== "") return raw;
  if (fallback !== undefined) return fallback;
  if (isOptionalRef(ref)) return undefined;
  throw new EnvironmentError({
    code: EnvironmentErrorCode.MissingVariables,
    message: `${application}: @DatabaseStorage({ ${option} }) has no value — ${variable} is not set`,
  });
}

/** Whether a reference is `secret.optional(…)`: it may be unset. */
const isOptionalRef = (ref: SecretRef | OptionalSecretRef): boolean =>
  ref instanceof OptionalSecretReference;

/** The keys the `@DatabaseStorage` names (#1321): its `idempotencySecret` and `previousIdempotencySecret`. */
function storageKeysOf(
  assembled: Pick<AssembledApplication, "name" | "storage">,
  env: NodeJS.ProcessEnv,
  fallback: FingerprintKeys | undefined,
): FingerprintKeys | undefined {
  const meta = assembled.storage?.database?.meta;
  if (meta?.idempotencySecret === undefined) return undefined;
  const current = storageSecretOf(
    assembled.name,
    "idempotencySecret",
    meta.idempotencySecret,
    env,
    fallback?.current,
  );
  if (current === undefined) return undefined;
  if (meta.previousIdempotencySecret === undefined) return Object.freeze({ current });
  const previous = storageSecretOf(
    assembled.name,
    "previousIdempotencySecret",
    meta.previousIdempotencySecret,
    env,
    fallback?.previous,
  );
  return Object.freeze(previous === undefined ? { current } : { current, previous });
}

/** An assembled application's idempotency keys (#825), as its instance's parts take them. */
export function applicationIdempotencyKeysOf(
  assembled: Pick<AssembledApplication, "name" | "storage"> & AssembledKeyFields,
  environment: Environment,
  env: NodeJS.ProcessEnv,
  fallback?: FingerprintKeys,
): { readonly fingerprintKeys?: FingerprintKeys } {
  const fromStorage = storageKeysOf(assembled, env, fallback);
  assertKeyVariablesApart(assembled.name, assembled, environment);
  if (fromStorage !== undefined) return { fingerprintKeys: fromStorage };
  // no storage declared (in-memory defaults): a test's keys, else none
  return assembled.storage?.database === undefined && fallback !== undefined
    ? { fingerprintKeys: fallback }
    : {};
}
