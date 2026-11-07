/**
 * #825 AC6 — no key field reads another key's variable, checked at start: two fields of the contract
 * given one variable are one key, whatever the field names say.
 */
import { describe, expect, it } from "vitest";
import { applicationIdempotencyKeysOf } from "../../src/application/idempotency-key.js";
import { assertKeyVariablesApart } from "../../src/application/key-variables.js";
import { EnvironmentError, EnvironmentErrorCode } from "../../src/environments/errors.js";
import { unitEnvironmentOf } from "../../src/environments/resolve.js";
import { secret } from "../../src/index.js";

const OTHER_KEYS = new Map([["openRouterApiKey", "the built-in OpenRouter providers' apiKey"]]);

const refusalOf = (
  keys: Parameters<typeof assertKeyVariablesApart>[1],
  values: object,
): unknown => {
  try {
    assertKeyVariablesApart("keys-application", keys, unitEnvironmentOf(values));
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#825 AC6: each key on a variable of its own", () => {
  it("the PII key on the provider key's variable: refused at start, naming both fields", () => {
    const refused = refusalOf(
      { piiKeyField: "piiKey", otherKeys: OTHER_KEYS },
      { piiKey: secret("SHARED_KEY"), openRouterApiKey: secret("SHARED_KEY") },
    );

    expect(refused).toBeInstanceOf(EnvironmentError);
    expect(refused).toMatchObject({
      code: EnvironmentErrorCode.InvalidValue,
      message:
        'keys-application: @Application({ piiKeyField: "piiKey" }) reads SHARED_KEY, as openRouterApiKey (the built-in OpenRouter providers\' apiKey) does — give it a variable of its own: rotating the other key would change every value made with this one',
    });
  });

  it("the idempotency key on the PII key's variable, or the previous one on the current one's: refused", () => {
    const keys = {
      piiKeyField: "piiKey",
      idempotencyKeyField: "idempotencyKey",
      previousIdempotencyKeyField: "previousKey",
    };

    expect(
      refusalOf(keys, {
        piiKey: secret("PII"),
        idempotencyKey: secret("PII"),
        previousKey: secret("OLD"),
      }),
    ).toMatchObject({ code: EnvironmentErrorCode.InvalidValue });
    expect(
      refusalOf(keys, {
        piiKey: secret("PII"),
        idempotencyKey: secret("CURRENT"),
        previousKey: secret("CURRENT"),
      }),
    ).toMatchObject({ code: EnvironmentErrorCode.InvalidValue });
  });

  it("variables of their own, or a field with no Secret (a test environment's): no problem", () => {
    const keys = {
      piiKeyField: "piiKey",
      idempotencyKeyField: "idempotencyKey",
      otherKeys: OTHER_KEYS,
    };

    expect(
      refusalOf(keys, {
        piiKey: secret("PII"),
        idempotencyKey: secret("IDEMPOTENCY"),
        openRouterApiKey: secret("OPENROUTER"),
      }),
    ).toBeUndefined();
    expect(refusalOf(keys, {})).toBeUndefined();
  });

  it("checked where the start reads the keys: applicationIdempotencyKeysOf refuses before any key is made", () => {
    const assembled = {
      name: "keys-application",
      piiKeyField: "piiKey",
      idempotencyKeyField: "idempotencyKey",
    };
    const values: object = { piiKey: secret("ONE_KEY"), idempotencyKey: secret("ONE_KEY") };
    const environment = unitEnvironmentOf(values);

    expect(() => applicationIdempotencyKeysOf(assembled, environment, { ONE_KEY: "k" })).toThrow(
      'keys-application: @Application({ piiKeyField: "piiKey" }) reads ONE_KEY, as idempotencyKey (idempotencyKeyField) does',
    );
  });
});
