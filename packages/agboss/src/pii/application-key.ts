import { ConfigError } from "../core/error-families/config-errors.js";
import { missingVariableError } from "../environments/environment-rules.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { OptionalSecretReference, variableOfSecretRef } from "../environments/secret.js";
import { violation } from "../graph/rule-error.js";

/**
 * The application's PII key (#120, #1301, #1321): `@DatabaseStorage({ piiSecret })`, the same on
 * every instance, so one value is one token on every machine. Anything that makes a token without a
 * `secret` of its own needs it: a `tokenize()` rule, a `sensitive: PiiAction.tokenize()` field —
 * when it is not set the start fails with `[pii.secret-required]`, never a key made up by the
 * instance. A `previousPiiSecret` is the key being rotated out: a token made under it is kept. The
 * fixed test key (`testWith`) is never used under `NODE_ENV=production`, and no storage — not even
 * `InMemoryDatabaseStorage` — supplies a key: a public constant would let anyone forge a token.
 * Without any token to make, a key of the instance masks the logs and keys the caches.
 */

/** The key a test's tokens are made with (`testWith`) when no key is set. */
export const TEST_PSEUDONYM_KEY = "agboss-test-pseudonym-key";

/** The previous key a test gets when `previousPiiSecret`'s variable is not set: another one. */
export const TEST_PREVIOUS_PSEUDONYM_KEY = "agboss-test-previous-pseudonym-key";

/** Where the key is read: the storage's secret, the process. */
export interface ApplicationKeySource {
  readonly application: string;
  /** `@DatabaseStorage({ piiSecret })` (#1321). */
  readonly secret?: SecretRef | OptionalSecretRef | undefined;
  /** `@DatabaseStorage({ previousPiiSecret })`: the key `secret` rotates from. */
  readonly previousSecret?: SecretRef | OptionalSecretRef | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** What makes tokens with the application's key: policies, DTO fields (names only). */
  readonly tokenizing: readonly string[];
  /** A test's key when the application's is not set (`testWith`): never a failure there. */
  readonly fallback?: string | undefined;
  /** The framework's own tests of a key per execution (#334): tokens on a key of the instance. */
  readonly isInstanceKeyAllowed?: boolean | undefined;
}

/** The application's key, and the one it rotates from. */
export interface ApplicationKeys {
  readonly key: string;
  readonly previousKey?: string;
}

const variableIn = (env: NodeJS.ProcessEnv, variable: string): string | undefined => {
  const raw = env[variable];
  return raw === undefined || raw === "" ? undefined : raw;
};

/**
 * The fixed key a test's instances share (`testWith`): never under `NODE_ENV=production`, whatever
 * the seam says — a key every reader of the source knows makes tokens anyone can forge or reverse.
 */
const testKeyOf = (source: ApplicationKeySource): string | undefined =>
  source.env.NODE_ENV === "production" ? undefined : source.fallback;

/** The value of a secret the storage names: its variable, or the test's key; else the start fails. */
function storageSecretOf(
  source: ApplicationKeySource,
  option: string,
  ref: SecretRef | OptionalSecretRef,
  fallback: string | undefined,
): string | undefined {
  const variable = variableOfSecretRef(ref);
  const value = variableIn(source.env, variable) ?? fallback;
  if (value !== undefined || ref instanceof OptionalSecretReference) return value;
  throw missingVariableError(
    `${source.application}: @DatabaseStorage({ ${option} }) has no value — ${variable} is not set`,
  );
}

/** `[pii.secret-required]`: something tokenizes and no key is named. Names only, never a value. */
const secretRequiredError = (
  application: string,
  tokenizing: readonly string[],
): ConfigError.GraphRules =>
  new ConfigError.GraphRules({
    violations: [
      violation(
        "pii.secret-required",
        `${application}: ${tokenizing.join(", ")} make tokens with the application's PII secret — name it in @DatabaseStorage({ …, piiSecret: secret("AGBOSS_PII_SECRET") }), or give each policy its own secret`,
        [application],
      ),
    ],
  });

/** The keys of `@DatabaseStorage({ piiSecret, previousPiiSecret })`: read from the variables, else the test's. */
function storageKeysOf(
  source: ApplicationKeySource,
  secret: SecretRef | OptionalSecretRef,
): ApplicationKeys | undefined {
  const key = storageSecretOf(source, "piiSecret", secret, testKeyOf(source));
  if (key === undefined) return undefined;
  if (source.previousSecret === undefined) return { key };
  const previousKey = storageSecretOf(
    source,
    "previousPiiSecret",
    source.previousSecret,
    testKeyOf(source) === undefined ? undefined : TEST_PREVIOUS_PSEUDONYM_KEY,
  );
  return previousKey === undefined ? { key } : { key, previousKey };
}

/** No key found: fine when nothing makes a token (or the instance's key is allowed); else the start fails. */
function assertNoKeyAllowed(source: ApplicationKeySource): void {
  if (source.tokenizing.length === 0 || source.isInstanceKeyAllowed === true) return;
  throw secretRequiredError(source.application, source.tokenizing);
}

/**
 * The application's keys; none when nothing makes a token and no key is named (a key of the
 * instance then masks its logs). Anything that tokenizes with no key to do it with fails the start.
 */
export function applicationPseudonymKeysOf(
  source: ApplicationKeySource,
): ApplicationKeys | undefined {
  if (source.secret !== undefined) {
    // an unset `secret.optional(…)` is never "no key needed" when something tokenizes
    const keys = storageKeysOf(source, source.secret);
    if (keys === undefined) assertNoKeyAllowed(source);
    return keys;
  }
  // no `piiSecret`: a test's key (`testWith`, never in production), else none — and a key of the
  // instance, unless something tokenizes (#1301b: never a key made up by the instance for a token)
  const test = testKeyOf(source);
  if (test !== undefined) return { key: test };
  assertNoKeyAllowed(source);
  return undefined;
}
