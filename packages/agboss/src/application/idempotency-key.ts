import { ConfigError } from "../core/error-families/config-errors.js";
import { IdempotencyError } from "../core/error-families/effect-errors.js";
import { missingVariable } from "../environments/environment-rules.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { OptionalSecretReference, variableOfSecretRef } from "../environments/secret.js";
import type { FingerprintKeys } from "../infrastructure/fenced-effect-key.js";
import type { AssembledApplication } from "./assemble.js";

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
): string | undefined {
  const variable = variableOfSecretRef(ref);
  const raw = env[variable];
  // never a key of the framework's own: a declared secret that is not set fails the start
  if (raw !== undefined && raw !== "") return raw;
  if (isOptionalRef(ref)) return undefined;
  throw new ConfigError.Environment({
    message: missingVariable(
      `${application}: @DatabaseStorage({ ${option} }) has no value — ${variable} is not set`,
    ),
  });
}

/** Whether a reference is `secret.optional(…)`: it may be unset. */
const isOptionalRef = (ref: SecretRef | OptionalSecretRef): boolean =>
  ref instanceof OptionalSecretReference;

/** The keys the `@DatabaseStorage` names (#1321): its `idempotencySecret` and `previousIdempotencySecret`. */
function storageKeysOf(
  assembled: Pick<AssembledApplication, "name" | "storage">,
  env: NodeJS.ProcessEnv,
): FingerprintKeys | undefined {
  const meta = assembled.storage?.database?.meta;
  if (meta?.idempotencySecret === undefined) return undefined;
  const current = storageSecretOf(assembled.name, "idempotencySecret", meta.idempotencySecret, env);
  if (current === undefined) return undefined;
  if (meta.previousIdempotencySecret === undefined) return Object.freeze({ current });
  const previous = storageSecretOf(
    assembled.name,
    "previousIdempotencySecret",
    meta.previousIdempotencySecret,
    env,
  );
  return Object.freeze(previous === undefined ? { current } : { current, previous });
}

/**
 * The refusal of an application whose components can write under a business key and whose
 * `idempotencySecret` is named but resolves to nothing (an optional reference left unset): the
 * start fails, never "no key" (#1317d).
 */
const unresolvedSecret = (application: string): IdempotencyError.SecretKeyMissing =>
  new IdempotencyError.SecretKeyMissing({
    message: `${application}: @DatabaseStorage({ idempotencySecret }) resolves to no value, and a component of the application can write under a business key — an idempotency secret that is unset or empty keys nothing: set its variable`,
    effect: application,
  });

/** A named secret that resolved to nothing: fine only where no component can write under a business key. */
function assertSecretNotNeeded(
  assembled: Pick<AssembledApplication, "name" | "storage" | "workflows">,
): void {
  const isNamed = assembled.storage?.database?.meta.idempotencySecret !== undefined;
  const reachesWriter = assembled.workflows.some((one) => one.businessKeyWriter !== undefined);
  if (isNamed && reachesWriter) throw unresolvedSecret(assembled.name);
}

/** The refusal of the test's idempotency keys in a production process (`NODE_ENV=production`). */
const testKeysInProduction = (): IdempotencyError.SecretKeyMissing =>
  new IdempotencyError.SecretKeyMissing({
    message:
      "the test's idempotency keys are public: they are never used when NODE_ENV is production — name idempotencySecret in @DatabaseStorage and set its variable",
    effect: "idempotency keys",
  });

/**
 * The environment of a test (`testWith`, a unit runner, a fault pod): a declared secret's variable
 * that is not set gets the test's key — in the test's environment only, never as a fallback of the
 * reader: `createApp` and every tool read the process as it is.
 */
function testEnvOf(
  assembled: Pick<AssembledApplication, "storage">,
  env: NodeJS.ProcessEnv,
  test: FingerprintKeys | undefined,
): NodeJS.ProcessEnv {
  const meta = assembled.storage?.database?.meta;
  if (test === undefined || meta === undefined) return env;
  const given: Record<string, string | undefined> = { ...env };
  const named = [
    [meta.idempotencySecret, test.current],
    [meta.previousIdempotencySecret, test.previous],
  ] as const;
  for (const [ref, value] of named) {
    if (ref === undefined || value === undefined) continue;
    const variable = variableOfSecretRef(ref);
    if (given[variable] === undefined || given[variable] === "") given[variable] = value;
  }
  return given;
}

/** An assembled application's idempotency keys (#825), as its instance's parts take them. */
export function applicationIdempotencyKeysOf(
  assembled: Pick<AssembledApplication, "name" | "storage" | "workflows">,
  env: NodeJS.ProcessEnv,
  fallback?: FingerprintKeys,
): { readonly fingerprintKeys?: FingerprintKeys } {
  if (fallback !== undefined && env.NODE_ENV === "production") throw testKeysInProduction();
  const fromStorage = storageKeysOf(assembled, testEnvOf(assembled, env, fallback));
  if (fromStorage === undefined) assertSecretNotNeeded(assembled);
  if (fromStorage !== undefined) return { fingerprintKeys: fromStorage };
  // no storage declared (in-memory defaults): a test's keys, else none
  return assembled.storage?.database === undefined && fallback !== undefined
    ? { fingerprintKeys: fallback }
    : {};
}
