/**
 * #1301 (1301a): the three verbs — `mask()` / `mask(part)`, `tokenize()`, `block(refusal?)` — on
 * `PiiAction` and on every `PiiKind` / `PiiGroup` descriptor, `PiiKind.fromId`, the fail-safe of a
 * model's kind of no id, and `[pii.duplicate-target]`.
 */
import { describe, expect, it } from "vitest";
import * as core from "../../src/index.js";
import { PiiAction, PiiActionKind, PiiGroup, PiiKind, PiiPolicy } from "../../src/index.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import { unitChatSettings } from "../../src/testing/units/unit-models.js";
import { modelDetectionOf, UNKNOWN_KIND_CODE } from "../../src/pii/detectors/model.js";
import { ALL_GROUPS, ALL_KINDS, isPiiGroup, kindsOf } from "../../src/pii/kinds.js";
import { piiPolicyMetaOf, policyViolations } from "../../src/pii/policy-checks.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { DetectionMode, runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import type { DeclarativePiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { replyWith, testUnit } from "../../src/testing/index.js";
import { fakeChatFactory } from "../helpers.js";

describe("#1301: PiiAction's verbs", () => {
  it("mask() is the kind's label, one-way", () => {
    expect(PiiAction.mask()).toEqual({ kind: PiiActionKind.Mask });
    expect(PiiActionKind.Mask).toBe("mask");
  });

  it("mask(part) keeps or replaces a part", () => {
    expect(PiiAction.mask({ keepLast: 4 })).toEqual({
      kind: PiiActionKind.MaskPart,
      part: { keepLast: 4 },
    });
    expect(PiiActionKind.MaskPart).toBe("mask-part");
  });

  it("tokenize() is the reversible one", () => {
    expect(PiiAction.tokenize()).toEqual({ kind: PiiActionKind.Tokenize });
    expect(PiiActionKind.Tokenize).toBe("tokenize");
  });

  it("block(refusal?) takes the text itself, no options object", () => {
    expect(PiiAction.block()).toEqual({ kind: PiiActionKind.Block });
    expect(PiiAction.block()).not.toHaveProperty("refusal");
    expect(PiiAction.block("No SSNs.")).toEqual({ kind: PiiActionKind.Block, refusal: "No SSNs." });
    expect(PiiActionKind.Block).toBe("block");
  });

  it("the 0.1.0 names are gone from the action and the entry", () => {
    for (const name of ["replaceWithKind", "replacePart", "replaceWithToken", "blockWithRefusal"])
      expect(PiiAction).not.toHaveProperty(name);
    expect(core).not.toHaveProperty("pii");
    expect(Object.values(PiiActionKind).sort()).toEqual(["block", "mask", "mask-part", "tokenize"]);
  });
});

describe("#1301: PiiKind and PiiGroup are descriptors", () => {
  it("a kind is written by its id: text, template, JSON — the label of its tokens stays", () => {
    expect(PiiKind.Email.id).toBe("email");
    expect(String(PiiKind.CardNumber)).toBe("card-number");
    expect(`<${PiiKind.IsraeliId.id}>`).toBe("<israeli-id>");
    expect(JSON.stringify({ kind: PiiKind.UsSsn, group: PiiGroup.Contact })).toBe(
      '{"kind":"us-ssn","group":"contact"}',
    );
    expect(PiiKind.Phone.toJSON()).toBe("phone");
  });

  it("every kind and group keeps its 0.1.0 id", () => {
    expect(ALL_KINDS.map((kind) => kind.id)).toEqual([
      "email",
      "phone",
      "street-address",
      "postal-code",
      "person-name",
      "date-of-birth",
      "us-ssn",
      "us-itin",
      "uk-nino",
      "israeli-id",
      "passport-number",
      "driver-license",
      "national-id",
      "card-number",
      "iban",
      "swift-bic",
      "bank-account",
      "us-ein",
      "ip-address",
      "mac-address",
      "geo-coordinates",
      "api-key",
      "jwt",
      "private-key",
      "password",
    ]);
    expect(ALL_GROUPS.map((group) => group.id)).toEqual([
      "contact",
      "identity",
      "government",
      "financial",
      "network",
      "credentials",
    ]);
  });

  it("each group has its kinds, each kind its one group", () => {
    expect(PiiGroup.Contact.kinds).toEqual([
      PiiKind.Email,
      PiiKind.Phone,
      PiiKind.StreetAddress,
      PiiKind.PostalCode,
    ]);
    for (const group of ALL_GROUPS) for (const kind of group.kinds) expect(kind.group).toBe(group);
    expect(ALL_GROUPS.flatMap((group) => group.kinds)).toHaveLength(ALL_KINDS.length);
    expect(isPiiGroup(PiiGroup.Financial)).toBe(true);
    expect(isPiiGroup(PiiKind.Iban)).toBe(false);
    expect(kindsOf(PiiKind.Iban)).toEqual([PiiKind.Iban]);
  });

  it("descriptors are singletons, frozen", () => {
    expect(PiiKind.fromId("email")).toBe(PiiKind.Email);
    expect(Object.isFrozen(PiiKind.Email)).toBe(true);
    expect(Object.isFrozen(PiiGroup.Contact)).toBe(true);
    expect(Object.isFrozen(PiiKind)).toBe(true);
    expect(new Set([PiiKind.Email, PiiKind.fromId("email")]).size).toBe(1);
  });

  it("fromId: a kind's id gives the kind; a group's id, an unknown or an empty one, none", () => {
    for (const kind of ALL_KINDS) expect(PiiKind.fromId(kind.id)).toBe(kind);
    expect(PiiKind.fromId("contact")).toBeUndefined();
    expect(PiiKind.fromId("Email")).toBeUndefined();
    expect(PiiKind.fromId("zip-code")).toBeUndefined();
    expect(PiiKind.fromId("")).toBeUndefined();
    expect(PiiKind.fromId("fromId")).toBeUndefined();
    expect(PiiKind.fromId("toString")).toBeUndefined();
  });

  it("a kind's verbs make its rule", () => {
    expect(PiiKind.Email.mask()).toEqual({ target: PiiKind.Email, action: PiiAction.mask() });
    expect(PiiKind.CardNumber.mask({ keepLast: 4 })).toEqual({
      target: PiiKind.CardNumber,
      action: PiiAction.mask({ keepLast: 4 }),
    });
    expect(PiiKind.Phone.tokenize()).toEqual({
      target: PiiKind.Phone,
      action: PiiAction.tokenize(),
    });
    expect(PiiKind.UsSsn.block("No SSNs.")).toEqual({
      target: PiiKind.UsSsn,
      action: PiiAction.block("No SSNs."),
    });
    expect(PiiKind.PassportNumber.block().action).toEqual({ kind: PiiActionKind.Block });
    expect(PiiKind.Email.mask().target).toBe(PiiKind.Email);
  });

  it("a group's verbs make its rule", () => {
    expect(PiiGroup.Contact.mask()).toEqual({ target: PiiGroup.Contact, action: PiiAction.mask() });
    expect(PiiGroup.Financial.mask({ pattern: /\d/gu }).action.kind).toBe(PiiActionKind.MaskPart);
    expect(PiiGroup.Network.tokenize().action).toEqual(PiiAction.tokenize());
    expect(PiiGroup.Government.block("No ids.").action).toEqual(PiiAction.block("No ids."));
    expect(PiiGroup.Credentials.mask().target).toBe(PiiGroup.Credentials);
  });
});

const policyOf = (rules: DeclarativePiiPolicyMeta["rules"]) => {
  @PiiPolicy({ name: "rules-pii-policy", description: "Rules under test", rules })
  class RulesPiiPolicy {}
  return RulesPiiPolicy;
};

const codesOf = (rules: DeclarativePiiPolicyMeta["rules"]): string[] =>
  policyViolations([policyOf(rules)]).map((violation) => violation.code);

describe("#1301: [pii.duplicate-target] — one rule per kind or group in a policy", () => {
  it("a kind named twice, with two actions or the same, is refused", () => {
    expect(codesOf([PiiKind.Email.mask(), PiiKind.Email.tokenize()])).toEqual([
      "pii.duplicate-target",
    ]);
    expect(codesOf([PiiKind.Email.mask(), PiiKind.Email.mask()])).toEqual(["pii.duplicate-target"]);
  });

  it("a group named twice is refused, once however many times it is named", () => {
    const violations = policyViolations([
      policyOf([PiiGroup.Contact.mask(), PiiGroup.Contact.tokenize(), PiiGroup.Contact.mask()]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("pii.duplicate-target");
    expect(violations[0]?.message).toBe(
      "rules-pii-policy: contact is named by more than one rule — give each kind or group one rule",
    );
    expect(violations[0]?.nodes).toEqual(["RulesPiiPolicy"]);
  });

  it("each target named twice is one violation of its own", () => {
    const violations = policyViolations([
      policyOf([
        PiiKind.Iban.mask(),
        PiiGroup.Network.mask(),
        PiiKind.Iban.block("No."),
        PiiGroup.Network.tokenize(),
      ]),
    ]);
    expect(violations.map((violation) => violation.message)).toEqual([
      "rules-pii-policy: iban is named by more than one rule — give each kind or group one rule",
      "rules-pii-policy: network is named by more than one rule — give each kind or group one rule",
    ]);
  });

  it("a kind and its group are two targets: the kind rule beats the group's", async () => {
    expect(codesOf([PiiGroup.Contact.mask(), PiiKind.Email.tokenize()])).toEqual([]);
    const { output } = await testUnit([
      policyOf([PiiGroup.Contact.mask(), PiiKind.Email.mask({ keepDomain: true })]),
    ]).mask("dana@acme.com, +1 415 555 0100");
    expect(output).toBe("d•••@acme.com, <phone>");
  });

  it("testUnit refuses a policy that names a target twice", () => {
    expect(() => testUnit([policyOf([PiiKind.Jwt.mask(), PiiKind.Jwt.tokenize()])])).toThrow(
      /pii\.duplicate-target/u,
    );
  });
});

@PiiPolicy({
  name: "names-pii-policy",
  description: "Names by model",
  rules: [PiiKind.PersonName.mask()],
  model: "acme/detector",
})
class NamesPiiPolicy {}

const SETTINGS = unitChatSettings("acme/detector");

/** A model that answers `content`, and a log that keeps its warnings. */
function detectionAnswering(content: string) {
  const warnings: { code: string; message: string }[] = [];
  const log: FrameworkLog = {
    info: () => undefined,
    warn: (code, message) => warnings.push({ code, message }),
    error: () => undefined,
  };
  const model = fakeChatFactory({ [SETTINGS.model]: [content] })(SETTINGS);
  return {
    detect: modelDetectionOf("names-pii-policy", { model, settings: SETTINGS }, log),
    warnings,
  };
}

async function maskedBy(content: string, text: string) {
  const { detect, warnings } = detectionAnswering(content);
  const meta = piiPolicyMetaOf(NamesPiiPolicy);
  if (meta === undefined) throw new Error("not a policy");
  const set = new PiiPolicySet(
    [runtimePolicyOf({ meta, instance: {}, key: "k", detection: detect })],
    "field-key",
  );
  const { masked } = await set.mask(text, {}, DetectionMode.WithModel);
  return { text: masked.text, warnings };
}

describe("#1301: a detection model's kind is read with PiiKind.fromId — none fails safe", () => {
  it("a kind the policy names takes its rule", async () => {
    const { text, warnings } = await maskedBy(
      '{"found":[{"kind":"person-name","text":"Dana Cohen"}]}',
      "from Dana Cohen",
    );
    expect(text).toBe("from <person-name>");
    expect(warnings).toEqual([]);
  });

  it("a kind of no id is masked as <pii>, with one warning per kind that never shows the value", async () => {
    const { text, warnings } = await maskedBy(
      '{"found":[{"kind":"full-name","text":"Dana Cohen"},{"kind":"full-name","text":"Ari Levi"}]}',
      "Dana Cohen and Ari Levi",
    );
    expect(text).toBe("<pii> and <pii>");
    expect(warnings).toEqual([
      {
        code: UNKNOWN_KIND_CODE,
        message:
          'PII policy names-pii-policy: the detection model named the kind "full-name", which is no PiiKind — its value is masked as <pii>',
      },
    ]);
    expect(UNKNOWN_KIND_CODE).toBe("pii.model-unknown-kind");
  });

  it("a kind that is not a kebab-case word is not written to the log", async () => {
    const { text, warnings } = await maskedBy(
      '{"found":[{"kind":"Dana Cohen <script>","text":"Dana Cohen"}]}',
      "hi Dana Cohen",
    );
    expect(text).toBe("hi <pii>");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("(not a kind name)");
    expect(warnings[0]?.message).not.toContain("Dana");
  });

  it("a known kind the policy names no rule for is masked too, under its own label", async () => {
    const { text, warnings } = await maskedBy(
      '{"found":[{"kind":"street-address","text":"1 Main St"}]}',
      "lives at 1 Main St",
    );
    expect(text).toBe("lives at <street-address>");
    expect(warnings).toEqual([]);
  });

  it("an empty text found masks nothing and says nothing", async () => {
    const { text, warnings } = await maskedBy('{"found":[{"kind":"x-y","text":"  "}]}', "a b");
    expect(text).toBe("a b");
    expect(warnings).toEqual([]);
  });

  it("through testUnit the same: a model's unknown kind never passes", async () => {
    const pii = testUnit([NamesPiiPolicy], {
      model: replyWith('{"found":[{"kind":"nickname","text":"Dee"}]}'),
    });
    expect((await pii.mask("ask Dee")).output).toBe("ask <pii>");
  });
});
