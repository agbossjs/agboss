/**
 * #1269 (files-pii mutation shard): the mask of a policy set carries the set's own keyed digests.
 */
import { describe, expect, it } from "vitest";
import { fileMaskOf } from "../../src/files/file-mask.js";
import { PiiAction } from "../../src/pii/actions.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { pii, type PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";

const meta: PiiPolicyMeta = {
  name: "cards-pii-policy",
  description: "cards",
  rules: [pii(PiiKind.CardNumber, PiiAction.replaceWithKind())],
  deps: [],
};
const set = new PiiPolicySet([runtimePolicyOf({ meta, instance: {}, key: "k" })], "field-key");

describe("a file mask is its policy set's", () => {
  it("none where nothing is masked", () => {
    expect(fileMaskOf(undefined, {})).toBeUndefined();
    expect(fileMaskOf(new PiiPolicySet([], "field-key"), {})).toBeUndefined();
  });

  it("the digest of a redacted copy is the set's keyed digest of the values the redactor is told", () => {
    const mask = fileMaskOf(set, {});

    expect(mask?.redactionDigestOf(["a", "b"])).toBe(set.redactionDigestOf(["a", "b"]));
    expect(mask?.redactionDigestOf(["b", "a"])).toBe(mask?.redactionDigestOf(["a", "b"]));
    expect(mask?.redactionDigestOf(["a"])).not.toBe(mask?.redactionDigestOf([]));
    expect(mask?.policyHash).toBe(set.fingerprint);
    expect(mask?.maskCacheKeyOf("text")).toBe(set.maskCacheKeyOf("text", true));
  });
});
