/**
 * #1366 (files-pii shard) — what a set of PII policies decides on its own, each rule over fake policies: the known
 * sensitive values found wherever they stand (two characters at least, each place, the first of two that overlap
 * by their own rank), an empty text searched by nobody (no model asked, nothing spent), what the log masks at once,
 * whether a block rule is among the policies, what a redactor is told to black out and which kinds refuse a file,
 * and the refusals a blocked finding and a kind raise.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { PiiActionKind } from "../../src/pii/actions.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { maskedText, type PiiFinding } from "../../src/pii/masking.js";
import { PiiFileAction } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet, type SensitiveValue } from "../../src/pii/policy-set.js";
import { DetectionMode, type RuntimePiiPolicy } from "../../src/pii/runtime-policy.js";

vi.mock("../../src/pii/masking.js", async (original) => {
  const real = await original<typeof import("../../src/pii/masking.js")>();
  return { ...real, maskedText: vi.fn(real.maskedText) };
});

const record = (costUsd: number): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "pii",
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const kindAction = { kind: PiiActionKind.ReplaceWithKind } as const;
const blockAction = { kind: PiiActionKind.BlockWithRefusal } as const;
const finding = (changes: Partial<PiiFinding> = {}): PiiFinding => ({
  start: 0,
  end: 4,
  label: "email",
  action: kindAction,
  key: "k",
  policy: "p1",
  rank: 0,
  ...changes,
});

/** What the fake policies were asked: kept apart from them, whose methods a test does not take off them. */
const spies = new WeakMap<RuntimePiiPolicy, { find: Mock; findNow: Mock }>();
const spiesOf = (policy: RuntimePiiPolicy): { find: Mock; findNow: Mock } => {
  const found = spies.get(policy);
  if (found === undefined) throw new Error("not a fake policy");
  return found;
};

/** A policy over fakes: what its search finds and costs, its formats' findings, its actions per kind. */
const policyOf = (
  name: string,
  changes: Partial<{
    actions: [string, object][];
    found: PiiFinding[];
    now: PiiFinding[];
    usage: UsageRecord[];
    files: PiiFileAction;
  }> = {},
): RuntimePiiPolicy => {
  const find = vi.fn((_text: string, _mode: DetectionMode) =>
    Promise.resolve({ findings: changes.found ?? [], usage: changes.usage ?? [] }),
  );
  const findNow = vi.fn((_text: string) => changes.now ?? []);
  const policy = {
    name,
    meta: { name, files: changes.files },
    actions: new Map(changes.actions ?? []),
    find,
    findNow,
    refusalOf: vi.fn((kind: string | undefined) => Promise.resolve(`refused ${String(kind)}`)),
  } as never as RuntimePiiPolicy;
  spies.set(policy, { find, findNow });
  return policy;
};

const value = (text: string, label = "user-id"): SensitiveValue => ({
  value: text,
  label,
  action: kindAction,
});
const setOf = (policies: RuntimePiiPolicy[] = [], values: SensitiveValue[] = []) =>
  new PiiPolicySet(policies, "field-key", values);

beforeEach(() => {
  vi.mocked(maskedText).mockClear();
});

describe("#1366: the sensitive values an execution knows", () => {
  it("are found wherever they stand, each place, and masked by their label", async () => {
    const out = await setOf([], [value("anna@x.io", "email")]).mask(
      "anna@x.io wrote to anna@x.io",
      {},
      DetectionMode.WithModel,
    );

    expect(out.masked.text).toBe("<email> wrote to <email>");
  });

  it("one of two characters is read, one of one is not: a single character is no value to look for", async () => {
    const set = setOf([], [value("a", "one"), value("bc", "two")]);

    const out = await set.mask("a bc a", {}, DetectionMode.WithModel);

    expect(out.masked.text).toBe("a <two> a");
  });

  it("is found at the very start of a text, and where it overlaps itself too: the first place wins", async () => {
    const set = setOf([], [value("aa", "pair")]);

    expect((await set.mask("aa", {}, DetectionMode.WithModel)).masked.text).toBe("<pair>");
    expect((await set.mask("aaa", {}, DetectionMode.WithModel)).masked.text).toBe("<pair>a");
  });

  it("wins over a policy's finding of the same place: the more specific detector is the lower rank", async () => {
    const policy = policyOf("p1", {
      found: [finding({ start: 0, end: 4, label: "policy-found", rank: 0 })],
    });
    const set = setOf([policy], [value("anna", "known")]);

    const out = await set.mask("anna", {}, DetectionMode.WithModel);

    expect(out.masked.text).toBe("<known>");
  });
});

describe("#1366: an empty text and what is spent searching it", () => {
  it("is searched by nobody: no policy's model is asked, nothing is spent, nothing is masked", async () => {
    const policy = policyOf("p1", { usage: [record(0.25)] });

    const out = await setOf([policy]).mask("", { tok: "v" }, DetectionMode.WithModel);

    expect(out).toEqual({ masked: { text: "", tokens: {}, blocked: [] }, usage: [] });
    expect(spiesOf(policy).find).not.toHaveBeenCalled();
  });

  it("a text is searched by every policy, in the mode asked, and what they cost is the search's", async () => {
    const first = policyOf("p1", { usage: [record(0.25)] });
    const second = policyOf("p2", { usage: [record(0.5)] });

    const out = await setOf([first, second]).mask("hello", {}, DetectionMode.WithoutModel);

    expect(spiesOf(first).find).toHaveBeenCalledWith("hello", DetectionMode.WithoutModel);
    expect(spiesOf(second).find).toHaveBeenCalledWith("hello", DetectionMode.WithoutModel);
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25, 0.5]);
  });
});

describe("#1366: what the log masks at once", () => {
  it("nothing for a set that masks nothing, nor for an empty text, though a policy would find something", () => {
    const policy = policyOf("p1", { now: [finding({ start: 0, end: 1 })] });

    expect(setOf().maskNow("text")).toBe("text");
    expect(setOf([policy]).maskNow("")).toBe("");
    expect(spiesOf(policy).findNow).not.toHaveBeenCalled();
  });

  it("what the formats find and the known values, masked; a text with nothing to mask is as it is, with no masking made", () => {
    const set = setOf(
      [policyOf("p1", { now: [finding({ start: 6, end: 10, label: "card" })] })],
      [value("anna", "user")],
    );

    expect(set.maskNow("anna: 1234 ok")).toBe("<user>: <card> ok");
    vi.mocked(maskedText).mockClear();
    expect(setOf([policyOf("p2")]).maskNow("nothing here")).toBe("nothing here");
    expect(maskedText).not.toHaveBeenCalled();
  });
});

describe("#1366: whether a block rule is among the policies", () => {
  it("is when any policy has one, and not for none, for policies without one, or for no policy", () => {
    // one rule of the policy blocks, the other masks: a policy has a block rule when any of its rules is one
    const blocking = policyOf("b", {
      actions: [
        ["email", kindAction],
        ["card", blockAction],
      ],
    });
    const masking = policyOf("m", { actions: [["email", kindAction]] });

    expect(setOf([masking, blocking]).blocks).toBe(true);
    expect(setOf([masking]).blocks).toBe(false);
    expect(setOf([]).blocks).toBe(false);
  });

  it("a set with no policy and no value masks nothing", () => {
    expect(setOf().isEmpty).toBe(true);
    expect(setOf([policyOf("p")]).isEmpty).toBe(false);
    expect(setOf([], [value("anna")]).isEmpty).toBe(false);
  });
});

describe("#1366: what a redactor is told to black out of a file", () => {
  it("every kind the policies' actions name once, the values it was told, the kinds a block rule names, and whether a model checks them", () => {
    const set = setOf(
      [
        policyOf("a", {
          actions: [
            ["email", kindAction],
            ["card", blockAction],
          ],
          files: PiiFileAction.RedactWithModel,
        }),
        policyOf("b", {
          actions: [
            ["card", blockAction],
            ["phone", blockAction],
          ],
          files: PiiFileAction.RedactWithModel,
        }),
        policyOf("c", { actions: [["email", kindAction]] }),
      ],
      [value("anna"), value("bob")],
    );

    expect(set.redaction).toEqual({
      kinds: ["email", "card", "phone"],
      values: ["anna", "bob"],
      blocked: ["card", "phone"],
      isModelChecked: true,
    });
  });

  it("a policy that blocks one kind and masks another is blocking: the kind it blocks is refused, the other blacked out", () => {
    const set = setOf([
      policyOf("mixed", {
        actions: [
          ["email", kindAction],
          ["card", blockAction],
        ],
        files: PiiFileAction.RedactWithModel,
      }),
    ]);

    expect(set.redaction).toMatchObject({
      kinds: ["email", "card"],
      blocked: ["card"],
      isModelChecked: true,
    });
  });

  it("is checked by no model when a policy with a block rule lets none decide, and by every one when none blocks", () => {
    const unchecked = setOf([
      policyOf("a", { actions: [["card", blockAction]], files: PiiFileAction.RedactWithModel }),
      policyOf("b", { actions: [["phone", blockAction]] }),
    ]);
    const nothingBlocked = setOf([policyOf("c", { actions: [["email", kindAction]] })]);

    expect(unchecked.redaction.isModelChecked).toBe(false);
    expect(nothingBlocked.redaction.isModelChecked).toBe(true);
    expect(nothingBlocked.redaction.blocked).toEqual([]);
    expect(setOf().redaction).toEqual({ kinds: [], values: [], blocked: [], isModelChecked: true });
  });
});

describe("#1366: the refusals of a set", () => {
  it("a kind a block rule names is refused with that policy's text; any other kind is blacked out, never refused", async () => {
    const set = setOf([
      policyOf("a", { actions: [["email", kindAction]] }),
      policyOf("b", { actions: [["card", blockAction]] }),
    ]);

    const refused = await set.refusalForKind("card" as never);

    expect(refused).toBeInstanceOf(PiiRefusedError);
    expect(refused).toMatchObject({ kind: "card", refusal: "refused card" });
    expect(await set.refusalForKind("email" as never)).toBeUndefined();
    expect(await set.refusalForKind("phone" as never)).toBeUndefined();
  });

  it("the first blocked finding is refused by its policy, carrying the spend so far; none, or one that is no block, is not", async () => {
    const set = setOf([policyOf("p1"), policyOf("p2")]);
    const blocked = finding({
      action: blockAction,
      policy: "p2",
      label: "card",
      kind: "card" as never,
    });

    const refused = await set.refusalError([blocked, finding({ policy: "p1" })], [record(0.25)]);

    expect(refused).toBeInstanceOf(PiiRefusedError);
    expect(refused).toMatchObject({ kind: "card", refusal: "refused card" });
    expect(refused?.usage.map((u) => u.costUsd)).toEqual([0.25]);
    expect(await set.refusalError([], [])).toBeUndefined();
    expect(await set.refusalError([finding({ action: kindAction })], [])).toBeUndefined();
  });

  it("a blocked finding of a policy the set does not have is refused with no text", async () => {
    const refused = await setOf().refusalError(
      [finding({ action: blockAction, policy: "gone" })],
      [],
    );

    expect(refused).toMatchObject({ refusal: "" });
  });
});
