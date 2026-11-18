/**
 * #1269 (shard `files-pii`): what a token and the policy set's hash are made of — the normalised value
 * (one value is one token however it is written), the shortest free prefix, the full digest when every
 * prefix stands for another value, and each policy setting that changes what a set masks with.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PiiAction } from "../../src/pii/actions.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { pii, PiiFileAction, type PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiKeyPurpose, purposeDigestOf } from "../../src/pii/key-hierarchy.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import { keyedDigestOf, normalisedValue, tokenOf } from "../../src/pii/tokens.js";

describe("normalisedValue: one value however it is written", () => {
  it("an email is lower-cased; another label keeps its case", () => {
    expect(normalisedValue("email", "  Dana@Example.COM ")).toBe("dana@example.com");
    expect(normalisedValue("name", "Dana Levi")).toBe("Dana Levi");
  });

  it("a number loses its separators: spaces, brackets, dots and dashes", () => {
    expect(normalisedValue("phone", "+972 (50) 111-11.11")).toBe("+972501111111");
    expect(normalisedValue("text", "1 2")).toBe("12");
    expect(normalisedValue("text", "1-2")).toBe("12");
    expect(normalisedValue("text", "1")).toBe("1");
  });

  it("a text that is not only a number keeps its separators, whitespace runs become one space", () => {
    expect(normalisedValue("text", "x 1-2")).toBe("x 1-2");
    expect(normalisedValue("text", "1-2 x")).toBe("1-2 x");
    expect(normalisedValue("text", "a-b  c\t\nd")).toBe("a-b c d");
    expect(normalisedValue("text", "a b")).toBe("a b");
  });
});

describe("keyedDigestOf: an HMAC-SHA256 in hex", () => {
  it("is the HMAC of the text under the key", () => {
    expect(keyedDigestOf("k", "text")).toBe(createHmac("sha256", "k").update("text").digest("hex"));
    expect(keyedDigestOf("k", "text")).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("tokenOf: the shortest free prefix", () => {
  const digest = purposeDigestOf("key", PiiKeyPurpose.Pseudonym, "dana@example.com");

  it("every shorter prefix standing for another value: the full digest", () => {
    const known: Record<string, string> = {};
    for (let length = 6; length < digest.length; length += 2)
      known[`<email:${digest.slice(0, length)}>`] = "someone@else.io";

    expect(tokenOf("email", "dana@example.com", "key", known)).toBe(`<email:${digest}>`);
  });

  it("even the full digest standing for another value (a collision): the full digest, never a loop", () => {
    const known: Record<string, string> = {};
    for (let length = 6; length <= digest.length; length += 2)
      known[`<email:${digest.slice(0, length)}>`] = "someone@else.io";

    expect(tokenOf("email", "dana@example.com", "key", known)).toBe(`<email:${digest}>`);
  });

  it("a prefix standing for the same value, written otherwise, is that value's token", () => {
    const known = { [`<email:${digest.slice(0, 6)}>`]: "DANA@example.com" };

    expect(tokenOf("email", "dana@example.com", "key", known)).toBe(
      `<email:${digest.slice(0, 6)}>`,
    );
  });
});

const policyWith = (extra: Partial<PiiPolicyMeta>) =>
  runtimePolicyOf({
    meta: {
      name: "cards-pii-policy",
      description: "cards",
      rules: [pii(PiiKind.CardNumber, PiiAction.replaceWithKind())],
      deps: [],
      ...extra,
    } as PiiPolicyMeta,
    instance: {},
    key: "k",
  });

describe("the policy set's hash covers each setting", () => {
  const plain = new PiiPolicySet([policyWith({})], "root");

  it("a model detection or a file action is another hash", () => {
    const detecting = new PiiPolicySet([policyWith({ detectWithModel: "m/model" })], "root");
    const files = new PiiPolicySet([policyWith({ files: PiiFileAction.AllowOriginal })], "root");

    expect(detecting.fingerprint).not.toBe(plain.fingerprint);
    expect(files.fingerprint).not.toBe(plain.fingerprint);
    expect(detecting.redactionDigestOf([])).not.toBe(plain.redactionDigestOf([]));
    expect(files.redactionDigestOf([])).not.toBe(plain.redactionDigestOf([]));
  });

  it("a policy with no model detection and no file action is hashed with both as null", () => {
    const rules = [pii(PiiKind.CardNumber, PiiAction.replaceWithKind())];
    const hashed = [{ name: "cards-pii-policy", masks: rules, model: null, files: null }];

    expect(plain.redactionDigestOf(["b", "a"])).toBe(
      purposeDigestOf("root", PiiKeyPurpose.FileCache, JSON.stringify([hashed, ["a", "b"]])).slice(
        0,
        32,
      ),
    );
  });

  it("a masked text's key says its role", () => {
    expect(plain.maskCacheKeyOf("t", true)).toMatch(/^in:[0-9a-f]{64}$/u);
    expect(plain.maskCacheKeyOf("t", false)).toMatch(/^out:[0-9a-f]{64}$/u);
  });

  it("no values, or the key it has, is the same set", () => {
    expect(plain.withValues([])).toBe(plain);
    expect(plain.withFieldKey("root")).toBe(plain);
    expect(plain.withFieldKey(null)).toBe(plain);
    expect(plain.withFieldKey(undefined)).toBe(plain);
    expect(plain.withFieldKey("other")).not.toBe(plain);
  });
});
