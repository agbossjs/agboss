import { PiiError } from "../../src/core/error-families/limit-errors.js";
import { usd } from "../../src/units/index.js";
/**
 * #1366 (files-pii shard) — what a policy set's model detectors cost: a search carries the spend of every policy's
 * detector, a text that is empty is searched by nobody and costs nothing, and the refusal of a blocked finding carries
 * the spend of the search that found it.
 */
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { DetectionMode } from "../../src/pii/runtime-policy.js";
import { PiiActionKind } from "../../src/pii/actions.js";

const record = (costUsd: number, caller = "pii"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const policyOf = (name: string, usage: UsageRecord[]) => ({
  name,
  meta: { name, rules: [] },
  actions: new Map(),
  find: vi.fn((_text: string, _mode: DetectionMode) => Promise.resolve({ findings: [], usage })),
  findNow: () => [],
  refusalOf: vi.fn(() => Promise.resolve(`refused by ${name}`)),
});

const setOf = (...policies: ReturnType<typeof policyOf>[]) =>
  new PiiPolicySet(policies as never, "field-key");

describe("#1366: the spend of a search", () => {
  it("is every policy's detector's, in the policies' order, and each is asked the text in the mode given", async () => {
    const first = policyOf("a-pii-policy", [record(0.25, "first")]);
    const second = policyOf("b-pii-policy", [record(0.125, "second")]);

    const out = await setOf(first, second).mask("hello", {}, DetectionMode.WithModel);

    expect(out.usage.map((u) => u.caller)).toEqual(["first", "second"]);
    expect(first.find).toHaveBeenCalledWith("hello", DetectionMode.WithModel);
    expect(second.find).toHaveBeenCalledWith("hello", DetectionMode.WithModel);
    expect(out.masked.text).toBe("hello");
  });

  it("an empty text is searched by no policy and costs nothing", async () => {
    const policy = policyOf("a-pii-policy", [record(0.25)]);

    const out = await setOf(policy).mask("", {}, DetectionMode.WithModel);

    expect(policy.find).not.toHaveBeenCalled();
    expect(out).toEqual({ masked: { text: "", tokens: {}, blocked: [] }, usage: [] });
  });

  it("a set that masks nothing finds and costs nothing in any text", async () => {
    const out = await setOf().mask("hello", { a: "1" }, DetectionMode.WithModel);

    expect(out).toEqual({ masked: { text: "hello", tokens: {}, blocked: [] }, usage: [] });
  });
});

describe("#1366: the refusal of a blocked finding", () => {
  const blocking = { kind: PiiActionKind.Block } as never;
  const finding = (policy: string, action: unknown = blocking) =>
    ({ policy, kind: "email", label: "email", action }) as never;

  it("is the policy's own text, for the kind that matched, and carries the spend of the search", async () => {
    const policy = policyOf("a-pii-policy", []);

    const refused = await setOf(policy).refusalError(
      [finding("a-pii-policy")],
      [record(0.25, "search")],
    );

    expect(refused).toBeInstanceOf(PiiError.Refused);
    expect(refused?.refusal).toBe("refused by a-pii-policy");
    expect(refused?.piiKind).toBe("email");
    expect(refused?.usage.map((u) => u.caller)).toEqual(["search"]);
    expect(policy.refusalOf).toHaveBeenCalledWith("email", blocking);
  });

  it("a finding of a policy the set does not hold is refused with no text of its own", async () => {
    const refused = await setOf(policyOf("a-pii-policy", [])).refusalError(
      [finding("gone-pii-policy")],
      [record(0.25, "search")],
    );

    expect(refused?.refusal).toBe("");
    expect(refused?.usage).toHaveLength(1);
  });

  it("no finding, or one a block rule did not make, refuses nothing", async () => {
    const set = setOf(policyOf("a-pii-policy", []));

    expect(await set.refusalError([], [])).toBeUndefined();
    expect(
      await set.refusalError([finding("a-pii-policy", { kind: PiiActionKind.Mask })], []),
    ).toBeUndefined();
  });
});
