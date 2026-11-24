import { describe, expectTypeOf, it } from "vitest";
import * as core from "../../src/index.js";
import {
  PiiAction,
  PiiActionKind,
  PiiGroup,
  PiiKind,
  type BlockAction,
  type MaskAction,
  type MaskingPiiAction,
  type MaskPartAction,
  type PiiGroupDescriptor,
  type PiiKindDescriptor,
  type PiiRule,
  type PiiTarget,
  type PiiTargetDescriptor,
  type TokenizeAction,
} from "../../src/index.js";
import type { Sensitivity } from "../../src/dto/types.js";

/**
 * #1301 (1301a): three verbs — `mask()` / `mask(part)`, `tokenize()`, `block(refusal?)` — on
 * `PiiAction` and on each `PiiKind` / `PiiGroup` descriptor; `pii(target, action)`, the four
 * `replace…` / `blockWithRefusal` names and `PiiRefusalOptions` are gone, with no alias.
 */

describe("#1301: the verbs of PiiAction", () => {
  it("mask() is MaskAction, mask(part) is MaskPartAction", () => {
    expectTypeOf(PiiAction.mask()).toEqualTypeOf<MaskAction>();
    expectTypeOf(PiiAction.mask({ keepLast: 4 })).toEqualTypeOf<MaskPartAction>();
    expectTypeOf(PiiAction.mask({ pattern: /x/u })).toEqualTypeOf<MaskPartAction>();
  });

  it("tokenize() is TokenizeAction, block(refusal?) is BlockAction", () => {
    expectTypeOf(PiiAction.tokenize()).toEqualTypeOf<TokenizeAction>();
    expectTypeOf(PiiAction.block()).toEqualTypeOf<BlockAction>();
    expectTypeOf(PiiAction.block).parameters.toEqualTypeOf<[refusal?: string]>();
  });

  it("the kinds of action are Mask, MaskPart, Tokenize, Block", () => {
    expectTypeOf<MaskAction["kind"]>().toEqualTypeOf<PiiActionKind.Mask>();
    expectTypeOf<MaskPartAction["kind"]>().toEqualTypeOf<PiiActionKind.MaskPart>();
    expectTypeOf<TokenizeAction["kind"]>().toEqualTypeOf<PiiActionKind.Tokenize>();
    expectTypeOf<BlockAction["kind"]>().toEqualTypeOf<PiiActionKind.Block>();
  });

  it("a sensitive field takes the masking verbs only", () => {
    expectTypeOf<Sensitivity>().toEqualTypeOf<MaskingPiiAction>();
    expectTypeOf(PiiAction.tokenize()).toExtend<Sensitivity>();
    expectTypeOf(PiiAction.block()).not.toExtend<Sensitivity>();
  });

  it("the 0.1.0 names are gone", () => {
    // @ts-expect-error -- replaceWithKind() is mask()
    PiiAction.replaceWithKind();
    // @ts-expect-error -- replacePart(part) is mask(part)
    PiiAction.replacePart({ keepLast: 4 });
    // @ts-expect-error -- replaceWithToken() is tokenize()
    PiiAction.replaceWithToken();
    // @ts-expect-error -- blockWithRefusal({ refusal }) is block(refusal)
    PiiAction.blockWithRefusal({ refusal: "No." });
    // @ts-expect-error -- block takes the text, not an options object
    PiiAction.block({ refusal: "No." });
    // @ts-expect-error -- PiiActionKind.ReplaceWithKind is PiiActionKind.Mask
    expectTypeOf(PiiActionKind.ReplaceWithKind).toBeString();
    // @ts-expect-error -- PiiActionKind.BlockWithRefusal is PiiActionKind.Block
    expectTypeOf(PiiActionKind.BlockWithRefusal).toBeString();
  });

  it("pii(), PiiRefusalOptions and the old action types are exported no more", () => {
    // @ts-expect-error -- pii(target, action) is the target's verb: PiiKind.Email.tokenize()
    expectTypeOf(core.pii).toBeFunction();
    // @ts-expect-error -- PiiRefusalOptions is gone: block(refusal) takes the text
    expectTypeOf<core.PiiRefusalOptions>().toBeObject();
    // @ts-expect-error -- ReplaceWithKindAction is MaskAction
    expectTypeOf<core.ReplaceWithKindAction>().toBeObject();
    // @ts-expect-error -- ReplacePartAction is MaskPartAction
    expectTypeOf<core.ReplacePartAction>().toBeObject();
    // @ts-expect-error -- ReplaceWithTokenAction is TokenizeAction
    expectTypeOf<core.ReplaceWithTokenAction>().toBeObject();
    // @ts-expect-error -- BlockWithRefusalAction is BlockAction
    expectTypeOf<core.BlockWithRefusalAction>().toBeObject();
  });
});

describe("#1301: PiiKind and PiiGroup are descriptors with the verbs", () => {
  it("a kind's and a group's verbs make a PiiRule", () => {
    expectTypeOf(PiiKind.Email.mask()).toEqualTypeOf<PiiRule>();
    expectTypeOf(PiiKind.CardNumber.mask({ keepLast: 4 })).toEqualTypeOf<PiiRule>();
    expectTypeOf(PiiKind.Phone.tokenize()).toEqualTypeOf<PiiRule>();
    expectTypeOf(PiiKind.UsSsn.block("No SSNs.")).toEqualTypeOf<PiiRule>();
    expectTypeOf(PiiGroup.Contact.mask()).toEqualTypeOf<PiiRule>();
    expectTypeOf(PiiGroup.Financial.block()).toEqualTypeOf<PiiRule>();
  });

  it("each is its descriptor, with an id and a JSON form", () => {
    expectTypeOf(PiiKind.Email).toEqualTypeOf<PiiKind>();
    expectTypeOf<PiiKind>().toEqualTypeOf<PiiKindDescriptor>();
    expectTypeOf<PiiGroup>().toEqualTypeOf<PiiGroupDescriptor>();
    expectTypeOf<PiiKind>().toExtend<PiiTargetDescriptor>();
    expectTypeOf<PiiTarget>().toEqualTypeOf<PiiKind | PiiGroup>();
    expectTypeOf(PiiKind.Email.id).toEqualTypeOf<string>();
    expectTypeOf(PiiKind.Email.toJSON()).toEqualTypeOf<string>();
    expectTypeOf(PiiKind.Email.group).toEqualTypeOf<PiiGroup>();
    expectTypeOf(PiiGroup.Contact.kinds).toEqualTypeOf<readonly PiiKind[]>();
  });

  it("fromId reads a kind back, or undefined; the kind type has no fromId", () => {
    expectTypeOf(PiiKind.fromId).toEqualTypeOf<(id: string) => PiiKind | undefined>();
    expectTypeOf<PiiKind>().not.toHaveProperty("fromId");
  });

  it("a group is no kind: refusal(kind: PiiKind) never gets a group", () => {
    expectTypeOf(PiiGroup.Contact).not.toExtend<PiiKind>();
    expectTypeOf(PiiKind.Email).not.toExtend<PiiGroup>();
  });

  it("a kind is a value, no longer a string or a type of its own", () => {
    expectTypeOf(PiiKind.Email).not.toBeString();
    // @ts-expect-error -- PiiKind.Email is a value, not a type (it was an enum member)
    expectTypeOf<PiiKind.Email>().toBeObject();
  });
});
