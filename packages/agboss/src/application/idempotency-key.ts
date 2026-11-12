import { EnvironmentError, EnvironmentErrorCode } from "../environments/errors.js";
import { isResolvedSecret, Secret, variableOfSecret } from "../environments/secret.js";
import type { Environment } from "../flow/generated-types.js";
import type { FingerprintKeys } from "../infrastructure/fenced-effect-key.js";
import type { AssembledApplication } from "./assemble.js";
import type { AssembledKeyFields } from "./assembled-keys.js";
import { assertKeyVariablesApart } from "./key-variables.js";

/**
 * The application's idempotency keys (#825, `@Application({ idempotencyKeyField,
 * previousIdempotencyKeyField })`): `Secret` fields of its environment, read when the app starts —
 * the same on every instance, used only for business-key fingerprints. Never the PII key, never a
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

/** Where the keys are read: the application's fields, its environment, the process. */
export interface IdempotencyKeySource {
  readonly application: string;
  readonly field?: string | undefined;
  readonly previousField?: string | undefined;
  readonly environment: Environment;
  readonly env: NodeJS.ProcessEnv;
  /** A test's keys when a named field has no value (`testWith`, as the PII key's): never a failure there. */
  readonly fallback?: FingerprintKeys | undefined;
}

/** A field's secret value; none when the environment has no `Secret` there or its variable is unset. */
function secretValueOf(source: IdempotencyKeySource, field: string): string | undefined {
  const value: unknown = Reflect.get(source.environment, field);
  if (!(value instanceof Secret)) return undefined;
  if (isResolvedSecret(value)) return value.reveal();
  const raw = source.env[variableOfSecret(value)];
  return raw === undefined || raw === "" ? undefined : raw;
}

/** The value of a named key field: a missing one fails the start, naming the field — never a value. */
function requiredValueOf(
  source: IdempotencyKeySource,
  field: string,
  option: string,
  fallback: string | undefined,
): string {
  const held: unknown = Reflect.get(source.environment, field);
  if (held === undefined && fallback !== undefined) return fallback;
  if (!(held instanceof Secret))
    throw new EnvironmentError({
      code: EnvironmentErrorCode.InvalidValue,
      message: `${source.application}: @Application({ ${option}: "${field}" }) names no Secret — set ${field}: secret("…") in the environment`,
    });
  const value = secretValueOf(source, field) ?? fallback;
  if (value !== undefined) return value;
  throw new EnvironmentError({
    code: EnvironmentErrorCode.MissingVariables,
    message: `${source.application}: @Application({ ${option}: "${field}" }) has no value — set ${field}: secret("…") in the environment and its variable`,
  });
}

/**
 * The application's idempotency keys (#825): none when it names no `idempotencyKeyField` (assembly
 * refuses that where business keys can be made, `[application.idempotency-key-required]`); a named
 * field without a value fails the start.
 */
export function idempotencyKeysOf(source: IdempotencyKeySource): FingerprintKeys | undefined {
  if (source.field === undefined) return undefined;
  const { fallback } = source;
  const current = requiredValueOf(source, source.field, "idempotencyKeyField", fallback?.current);
  if (source.previousField === undefined) return Object.freeze({ current });
  const option = "previousIdempotencyKeyField";
  const previous = requiredValueOf(source, source.previousField, option, fallback?.previous);
  return Object.freeze({ current, previous });
}

/** An assembled application's idempotency keys (#825), as its instance's parts take them. */
export function applicationIdempotencyKeysOf(
  assembled: Pick<AssembledApplication, "name"> & AssembledKeyFields,
  environment: Environment,
  env: NodeJS.ProcessEnv,
  fallback?: FingerprintKeys,
): { readonly fingerprintKeys?: FingerprintKeys } {
  assertKeyVariablesApart(assembled.name, assembled, environment);
  const fingerprintKeys = idempotencyKeysOf({
    application: assembled.name,
    field: assembled.idempotencyKeyField,
    previousField: assembled.previousIdempotencyKeyField,
    environment,
    env,
    fallback,
  });
  return fingerprintKeys === undefined ? {} : { fingerprintKeys };
}
