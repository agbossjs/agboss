/**
 * #1301b: an unset `secret.optional(…)` as the application's `piiSecret` is never "no key needed"
 * when something tokenizes — the start fails with `[pii.secret-required]`, not a silent key.
 */
import { describe, expect, it } from "vitest";
import { secret } from "../../src/index.js";
import {
  applicationPseudonymKeysOf,
  type ApplicationKeySource,
} from "../../src/pii/application-key.js";

const sourceOf = (more: Partial<ApplicationKeySource>): ApplicationKeySource => ({
  application: "pii-application",
  secret: secret.optional("OPTIONAL_PII_SECRET"),
  env: {},
  tokenizing: [],
  ...more,
});

const refusalOf = (source: ApplicationKeySource): unknown => {
  try {
    applicationPseudonymKeysOf(source);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1301b: an optional piiSecret", () => {
  it("unset and a tokenize() policy: the start fails with [pii.secret-required]", () => {
    expect(refusalOf(sourceOf({ tokenizing: ["policy Customer"] }))).toMatchObject({
      violations: [
        { code: "pii.secret-required", message: expect.stringContaining("policy Customer") },
      ],
    });
  });

  it("unset and a sensitive: tokenize() field: the start fails too", () => {
    expect(refusalOf(sourceOf({ tokenizing: ["field Dto.email"] }))).toMatchObject({
      violations: [{ code: "pii.secret-required" }],
    });
  });

  it("an empty variable counts as unset", () => {
    expect(
      refusalOf(sourceOf({ tokenizing: ["policy Customer"], env: { OPTIONAL_PII_SECRET: "" } })),
    ).toMatchObject({ violations: [{ code: "pii.secret-required" }] });
  });

  it("set: the key, and the tokens work", () => {
    expect(
      applicationPseudonymKeysOf(
        sourceOf({ tokenizing: ["policy Customer"], env: { OPTIONAL_PII_SECRET: "the key" } }),
      ),
    ).toEqual({ key: "the key" });
  });

  it("unset and nothing tokenizes: it starts, with no key", () => {
    expect(applicationPseudonymKeysOf(sourceOf({}))).toBeUndefined();
  });

  it("an unset optional previousPiiSecret is fine; an unset required one fails", () => {
    const env = { OPTIONAL_PII_SECRET: "the key" };
    expect(
      applicationPseudonymKeysOf(
        sourceOf({ env, tokenizing: ["policy C"], previousSecret: secret.optional("PREV_UNSET") }),
      ),
    ).toEqual({ key: "the key" });
    expect(
      refusalOf(sourceOf({ env, tokenizing: ["policy C"], previousSecret: secret("PREV_UNSET") })),
    ).toMatchObject({ message: expect.stringContaining("previousPiiSecret") });
  });
});
