/**
 * #825 AC7, #1317 — the application's idempotency keys, read at start from its database storage
 * (`idempotencySecret`, `previousIdempotencySecret`): a secret without a value fails the start naming
 * the variable; under `testWith` (its `fallback`) a secret with no value gets the test's keys; an
 * application with no storage gets the test's keys only. (The `idempotencyKeyField` options of
 * `@Application`, and the environment field they named, are gone: nothing of them is tested.)
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import {
  applicationIdempotencyKeysOf,
  TEST_IDEMPOTENCY_KEYS,
} from "../../src/application/idempotency-key.js";
import { EnvironmentErrorCode } from "../../src/environments/errors.js";
import { unitEnvironmentOf } from "../../src/environments/resolve.js";
import { secret } from "../../src/index.js";
import type { FingerprintKeys } from "../../src/infrastructure/fenced-effect-key.js";

interface Secrets {
  readonly idempotencySecret?: ReturnType<typeof secret>;
  readonly previousIdempotencySecret?:
    ReturnType<typeof secret> | ReturnType<typeof secret.optional>;
}

/** An assembled application whose database storage names `secrets` (none: no storage at all). */
const assembledWith = (secrets?: Secrets) =>
  ({
    name: "keys-application",
    workflows: [],
    storage: secrets === undefined ? undefined : { database: { meta: secrets } },
  }) as never;

const keysOf = (
  secrets: Secrets | undefined,
  env: NodeJS.ProcessEnv = {},
  fallback?: FingerprintKeys,
) => applicationIdempotencyKeysOf(assembledWith(secrets), unitEnvironmentOf({}), env, fallback);

const refusalOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#825 AC7: the idempotency keys at start", () => {
  it("no storage and no fallback: no keys", () => {
    expect(keysOf(undefined)).toEqual({});
  });

  it("the secret's variable set: the current key; the previous one beside it during a rotation", () => {
    const env = { KEY_V2: "v2", KEY_V1: "v1" };

    expect(keysOf({ idempotencySecret: secret("KEY_V2") }, env)).toEqual({
      fingerprintKeys: { current: "v2" },
    });
    expect(
      keysOf(
        { idempotencySecret: secret("KEY_V2"), previousIdempotencySecret: secret("KEY_V1") },
        env,
      ),
    ).toEqual({ fingerprintKeys: { current: "v2", previous: "v1" } });
  });

  it("a secret whose variable is unset fails the start, naming the variable — never a value", () => {
    const refused = refusalOf(() => keysOf({ idempotencySecret: secret("KEY_V2") }));

    expect(refused).toBeInstanceOf(ConfigError.Environment);
    expect(refused).toMatchObject({
      envCode: EnvironmentErrorCode.MissingVariables,
      message: expect.stringContaining("KEY_V2 is not set"),
    });
  });

  it("a previous secret without a value fails the start too; an optional one may be unset", () => {
    const both = {
      idempotencySecret: secret("KEY_V2"),
      previousIdempotencySecret: secret("KEY_V1"),
    };

    expect(refusalOf(() => keysOf(both, { KEY_V2: "v2" }))).toMatchObject({
      envCode: EnvironmentErrorCode.MissingVariables,
    });
    expect(
      keysOf({ ...both, previousIdempotencySecret: secret.optional("KEY_V1") }, { KEY_V2: "v2" }),
    ).toEqual({ fingerprintKeys: { current: "v2" } });
  });

  it("under testWith: a secret with no value gets the test's keys; one set is the key", () => {
    const fallback = TEST_IDEMPOTENCY_KEYS;
    const rotating = {
      idempotencySecret: secret("KEY_V2"),
      previousIdempotencySecret: secret("KEY_V1"),
    };

    expect(keysOf(rotating, {}, fallback)).toEqual({ fingerprintKeys: TEST_IDEMPOTENCY_KEYS });
    expect(keysOf(rotating, { KEY_V2: "v2" }, fallback)).toEqual({
      fingerprintKeys: { current: "v2", previous: TEST_IDEMPOTENCY_KEYS.previous },
    });
  });

  it("under testWith: an application with no storage gets the test's keys", () => {
    expect(keysOf(undefined, {}, TEST_IDEMPOTENCY_KEYS)).toEqual({
      fingerprintKeys: TEST_IDEMPOTENCY_KEYS,
    });
  });
});
