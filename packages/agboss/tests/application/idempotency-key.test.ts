/**
 * #825 AC7 — the application's idempotency keys, read at start: a named field without a value fails
 * the start naming the field, a field that holds no `Secret` too; under `testWith` (its `fallback`)
 * a field with no value gets the test's keys, never a field of another type.
 */
import { describe, expect, it } from "vitest";
import {
  idempotencyKeysOf,
  TEST_IDEMPOTENCY_KEYS,
  type IdempotencyKeySource,
} from "../../src/application/idempotency-key.js";
import { EnvironmentError, EnvironmentErrorCode } from "../../src/environments/errors.js";
import { unitEnvironmentOf } from "../../src/environments/resolve.js";
import { secret } from "../../src/index.js";
import type { Environment } from "../../src/flow/generated-types.js";

const sourceOf = (
  environment: Record<string, unknown>,
  more: Partial<IdempotencyKeySource> = {},
): IdempotencyKeySource => ({
  application: "keys-application",
  field: "idempotencyKey",
  environment: unitEnvironmentOf(environment),
  env: {},
  ...more,
});

const refusalOf = (source: IdempotencyKeySource): unknown => {
  try {
    idempotencyKeysOf(source);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#825 AC7: the idempotency keys at start", () => {
  it("no field named: no keys", () => {
    expect(idempotencyKeysOf(sourceOf({}, { field: undefined }))).toBeUndefined();
  });

  it("the field's variable set: the current key; the previous one beside it during a rotation", () => {
    const environment = { idempotencyKey: secret("KEY_V2"), previousKey: secret("KEY_V1") };
    const env = { KEY_V2: "v2", KEY_V1: "v1" };

    expect(idempotencyKeysOf(sourceOf(environment, { env }))).toEqual({ current: "v2" });
    expect(idempotencyKeysOf(sourceOf(environment, { env, previousField: "previousKey" }))).toEqual(
      { current: "v2", previous: "v1" },
    );
  });

  it("a named field whose variable is unset fails the start, naming the field — never a value", () => {
    const refused = refusalOf(sourceOf({ idempotencyKey: secret("KEY_V2") }));

    expect(refused).toBeInstanceOf(EnvironmentError);
    expect(refused).toMatchObject({
      code: EnvironmentErrorCode.MissingVariables,
      message: expect.stringContaining(
        '@Application({ idempotencyKeyField: "idempotencyKey" }) has no value',
      ),
    });
  });

  it("a named previous field without a value fails the start too", () => {
    const environment = { idempotencyKey: secret("KEY_V2"), previousKey: secret("KEY_V1") };

    expect(
      refusalOf(sourceOf(environment, { env: { KEY_V2: "v2" }, previousField: "previousKey" })),
    ).toMatchObject({ code: EnvironmentErrorCode.MissingVariables });
  });

  it("a field that holds no Secret, or none at all, is refused naming it", () => {
    for (const environment of [{ idempotencyKey: "a literal key" }, {}])
      expect(refusalOf(sourceOf(environment))).toMatchObject({
        code: EnvironmentErrorCode.InvalidValue,
        message: expect.stringContaining('names no Secret — set idempotencyKey: secret("…")'),
      });
  });

  it("under testWith: a field with no value — left out, or its variable unset — gets the test's keys", () => {
    const fallback = TEST_IDEMPOTENCY_KEYS;
    const rotating = { previousField: "previousKey", fallback };

    expect(idempotencyKeysOf(sourceOf({}, rotating))).toEqual(TEST_IDEMPOTENCY_KEYS);
    expect(idempotencyKeysOf(sourceOf({ idempotencyKey: secret("KEY_V2") }, { fallback }))).toEqual(
      { current: TEST_IDEMPOTENCY_KEYS.current },
    );
  });

  it("under testWith: a value set is the key, and a field that holds no Secret is still refused", () => {
    const fallback = TEST_IDEMPOTENCY_KEYS;
    const given = sourceOf(
      { idempotencyKey: secret("KEY_V2") },
      { env: { KEY_V2: "v2" }, fallback },
    );

    expect(idempotencyKeysOf(given)).toEqual({ current: "v2" });
    expect(refusalOf(sourceOf({ idempotencyKey: "a literal key" }, { fallback }))).toMatchObject({
      code: EnvironmentErrorCode.InvalidValue,
    });
  });
});
