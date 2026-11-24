import { describe, expectTypeOf, it } from "vitest";
import type { Class } from "../../src/components/injection.js";
import type { OptionalSecretRef, SecretRef } from "../../src/environments/env-ref.js";
import type { DatabaseStorageOptions } from "../../src/storage/storage-decorators.js";
import type {
  CustomPiiPolicyOptions,
  DeclarativePiiPolicyOptions,
} from "../../src/pii/pii-policy.decorator.js";

/**
 * #1301 (1301b): a declarative `@PiiPolicy` has `secret` / `previousSecret` and `model` /
 * `modelProvider`; `@DatabaseStorage` has `previousPiiSecret` beside `piiSecret`;
 * `pseudonymKey` and `detectWithModel` are gone, with no alias.
 */
describe("#1301b: the options of a declarative policy", () => {
  it("secret is a SecretRef, previousSecret a SecretRef or an optional one", () => {
    expectTypeOf<DeclarativePiiPolicyOptions["secret"]>().toEqualTypeOf<SecretRef | undefined>();
    expectTypeOf<DeclarativePiiPolicyOptions["previousSecret"]>().toEqualTypeOf<
      SecretRef | OptionalSecretRef | undefined
    >();
  });

  it("model is a name, modelProvider a class", () => {
    expectTypeOf<DeclarativePiiPolicyOptions["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DeclarativePiiPolicyOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
  });

  it("the removed names are no options", () => {
    expectTypeOf<DeclarativePiiPolicyOptions>().not.toHaveProperty("pseudonymKey");
    expectTypeOf<DeclarativePiiPolicyOptions>().not.toHaveProperty("detectWithModel");
  });

  it("a project's own detector has neither a key of its own nor a model", () => {
    expectTypeOf<CustomPiiPolicyOptions>().not.toHaveProperty("secret");
    expectTypeOf<CustomPiiPolicyOptions>().not.toHaveProperty("model");
  });
});

describe("#1301b: the storage's PII keys", () => {
  it("piiSecret is a SecretRef, previousPiiSecret a SecretRef or an optional one", () => {
    expectTypeOf<DatabaseStorageOptions["piiSecret"]>().toEqualTypeOf<SecretRef | undefined>();
    expectTypeOf<DatabaseStorageOptions["previousPiiSecret"]>().toEqualTypeOf<
      SecretRef | OptionalSecretRef | undefined
    >();
  });
});
