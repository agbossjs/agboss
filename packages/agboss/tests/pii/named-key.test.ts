/**
 * #825 AC6 — `@Application({ piiKeyField })` named: its value, or the start fails naming the field —
 * never a silent key of the instance; `testWith`'s key (`fallback`) stands in for it in a test.
 */
import { describe, expect, it } from "vitest";
import { EnvironmentErrorCode } from "../../src/environments/errors.js";
import { unitEnvironmentOf } from "../../src/environments/resolve.js";
import { secret } from "../../src/index.js";
import { applicationPseudonymKeyOf } from "../../src/pii/application-key.js";

const sourceOf = (values: object, more: { fallback?: string; field?: string } = {}) => ({
  application: "pii-application",
  field: "piiKey",
  environment: unitEnvironmentOf(values),
  env: { PII_KEY: "the key" },
  policies: [],
  ...more,
});

const refusalOf = (source: ReturnType<typeof sourceOf>): unknown => {
  try {
    applicationPseudonymKeyOf(source);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#825 AC6: a named PII key", () => {
  it("its variable set: the key", () => {
    expect(applicationPseudonymKeyOf(sourceOf({ piiKey: secret("PII_KEY") }))).toBe("the key");
  });

  it("its variable unset: the start fails naming the field, no key of the instance", () => {
    expect(refusalOf(sourceOf({ piiKey: secret("UNSET_PII_KEY") }))).toMatchObject({
      code: EnvironmentErrorCode.MissingVariables,
      message:
        'pii-application: @Application({ piiKeyField: "piiKey" }) has no value — set piiKey: secret("…") in the environment and its variable',
    });
  });

  it("a field that holds no Secret, or none: refused naming it", () => {
    for (const values of [{ piiKey: "a literal key" }, {}])
      expect(refusalOf(sourceOf(values))).toMatchObject({
        code: EnvironmentErrorCode.InvalidValue,
        message: expect.stringContaining('@Application({ piiKeyField: "piiKey" }) names no Secret'),
      });
  });

  it("under testWith: the test's key stands in; none named and none needed: none", () => {
    expect(applicationPseudonymKeyOf(sourceOf({}, { fallback: "test key" }))).toBe("test key");
    expect(applicationPseudonymKeyOf(sourceOf({}, { field: undefined }))).toBeUndefined();
  });
});
