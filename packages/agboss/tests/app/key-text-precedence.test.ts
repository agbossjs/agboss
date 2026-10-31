/**
 * #547 acceptance — a text that breaks several rules of a key's text is named by one rule, the same
 * one at every entry point and wherever in the text each breach stands: the first of
 * `KEY_TEXT_PRECEDENCE`. Every set of two or more breaches, each written after the one it outranks,
 * and a property over random sets, orders and fillers against an oracle of its own.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { InvalidThreadIdError, KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import {
  Action,
  ExecutionContext,
  fencedEffectKeyOf,
  InvalidBusinessKeyError,
} from "../../src/index.js";
import { testAction, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { seededProperties } from "../helpers/property-seed.js";
import { ChatStart, DeskApplication } from "../testing/fixtures/desk.workflow.js";

seededProperties("key-text-precedence.test.ts");

/** The order a text's rules are named in: `KeyTextRule`'s, as CLAUDE.md and the Wiki list them. */
const KEY_TEXT_PRECEDENCE: readonly KeyTextRule[] = [
  KeyTextRule.Length,
  KeyTextRule.LoneSurrogate,
  KeyTextRule.ControlCharacter,
  KeyTextRule.FormatCharacter,
  KeyTextRule.SpaceSeparator,
  KeyTextRule.Spacing,
  KeyTextRule.Ignorable,
  KeyTextRule.PrivateOrNoncharacter,
  KeyTextRule.Unassigned,
  KeyTextRule.Blank,
  KeyTextRule.NotNfc,
];

/** One breach of each rule but the length, each breaking that rule alone between two letters. */
const BREACHES: readonly (readonly [KeyTextRule, string])[] = [
  [KeyTextRule.LoneSurrogate, "\uD800"],
  [KeyTextRule.ControlCharacter, "\t"],
  [KeyTextRule.FormatCharacter, "\u200B"],
  [KeyTextRule.SpaceSeparator, "\u00A0"],
  [KeyTextRule.Spacing, "  "],
  [KeyTextRule.Ignorable, "\u034F"],
  [KeyTextRule.PrivateOrNoncharacter, "\uE000"],
  [KeyTextRule.Unassigned, "\u0378"],
  [KeyTextRule.Blank, "\u2800"],
  [KeyTextRule.NotNfc, "e\u0301"],
];

const rank = (rule: KeyTextRule): number => KEY_TEXT_PRECEDENCE.indexOf(rule);

/** Every set of two or more breaches, the lowest-ranked written first: `[rules, text]`. */
const SETS: readonly (readonly [string, KeyTextRule, string])[] = Array.from(
  { length: 2 ** BREACHES.length },
  (_, mask) => BREACHES.filter((_breach, index) => (mask & (1 << index)) !== 0),
)
  .filter((set) => set.length >= 2)
  .map((set) => {
    const written = [...set].sort(([left], [right]) => rank(right) - rank(left));
    const text = `a${written.map(([, breach]) => `${breach}b`).join("")}`;
    const [[expected]] = [...set].sort(([left], [right]) => rank(left) - rank(right)) as [
      readonly [KeyTextRule, string],
    ];
    return [written.map(([rule]) => rule).join(" > "), expected, text] as const;
  });

describe("#547 acceptance: several breaches name the first rule of the precedence, wherever they stand", () => {
  it("the precedence is KeyTextRule's declared order, as its documentation says", () => {
    expect(Object.values(KeyTextRule)).toEqual(KEY_TEXT_PRECEDENCE);
  });

  it.each(SETS)("%s → %s", (_label, expected, text) => {
    expect(keyTextRuleOf(text)).toBe(expected);
  });

  it.each(BREACHES)("201 characters holding a %s breach → length", (_rule, breach) => {
    const text = `${breach}${"k".repeat(201 - breach.length)}`;
    expect(text.length).toBe(201);
    expect(keyTextRuleOf(text)).toBe(KeyTextRule.Length);
  });
});

/** The code points of `text`, a lone surrogate as one of its own. */
const codePointsOf = (text: string): number[] =>
  Array.from(text, (char) => char.codePointAt(0) ?? 0);

/** Whether `text` holds half of a surrogate pair standing alone, by its code units. */
function hasLoneSurrogate(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    const next = text.charCodeAt(at + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) at += 1;
    else if (unit >= 0xd800 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Whether `text` breaks `rule`, decided code point by code point — not by the core's patterns. */
const BREAKS: Readonly<Record<KeyTextRule, (text: string) => boolean>> = {
  [KeyTextRule.Length]: (text) => text.length === 0 || text.length > 200,
  [KeyTextRule.LoneSurrogate]: hasLoneSurrogate,
  [KeyTextRule.ControlCharacter]: (text) =>
    codePointsOf(text).some((code) => code < 0x20 || (code >= 0x7f && code <= 0x9f)),
  [KeyTextRule.FormatCharacter]: (text) => /\p{General_Category=Format}/u.test(text),
  [KeyTextRule.SpaceSeparator]: (text) =>
    codePointsOf(text).some(
      (code) => code !== 0x20 && /\p{General_Category=Separator}/u.test(String.fromCodePoint(code)),
    ),
  [KeyTextRule.Spacing]: (text) =>
    text.startsWith(" ") || text.endsWith(" ") || text.includes("  "),
  // #556, by the properties' own names, code point by code point
  [KeyTextRule.Ignorable]: (text) =>
    codePointsOf(text).some((code) =>
      /\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(code)),
    ),
  [KeyTextRule.PrivateOrNoncharacter]: (text) =>
    codePointsOf(text).some(
      (code) =>
        (code >= 0xfdd0 && code <= 0xfdef) ||
        (code & 0xfffe) === 0xfffe ||
        /\p{General_Category=Private_Use}/u.test(String.fromCodePoint(code)),
    ),
  [KeyTextRule.Unassigned]: (text) =>
    codePointsOf(text).some((code) =>
      /\p{General_Category=Unassigned}/u.test(String.fromCodePoint(code)),
    ),
  [KeyTextRule.Blank]: (text) => text.includes("\u2800"),
  [KeyTextRule.NotNfc]: (text) => !hasLoneSurrogate(text) && text.normalize("NFC") !== text,
};

/** Letters a breach can stand beside without making another one. */
const FILLER = fc.string({
  unit: fc.constantFrom("a", "z", "7", ":", "注", "ж", "ש", "🧾"),
  maxLength: 4,
});

describe("#547 acceptance: the rule named is the precedence's first one the text breaks (property)", () => {
  it("random breaches in random order, between random letters", () => {
    fc.assert(
      fc.property(
        fc.subarray([...BREACHES], { minLength: 1 }),
        fc.array(FILLER, { minLength: 11, maxLength: 11 }),
        fc.boolean(),
        (set, fillers, isLong) => {
          const body = set.map(([, breach], at) => `${fillers[at] ?? ""}${breach}`).join("");
          const text = `a${body}${fillers[10] ?? ""}b${isLong ? "k".repeat(201) : ""}`;
          const expected = KEY_TEXT_PRECEDENCE.find((rule) => BREAKS[rule](text));
          expect(keyTextRuleOf(text)).toBe(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

@Action({
  name: "precedence-charge-action",
  description: "Keys a charge by the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowStartTextDto,
  deps: [ExecutionContext],
})
class PrecedenceChargeAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly message: { readonly value: WorkflowStartTextDto } }) {
    const key = fencedEffectKeyOf(this.executionContext, "charge", {
      businessKey: input.message.value.text,
    });
    return Promise.resolve({ text: key.businessKey ?? "" });
  }
}

const desk = testWith(DeskApplication);

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#547 acceptance: every entry point names the same rule for a text breaking two", () => {
  desk.for(SETS.filter(([label]) => label.split(" > ").length === 2))(
    "%s → %s",
    async ([, expected, text], { app }) => {
      const businessKey = await rejectionOf(
        testAction(PrecedenceChargeAction)({ message: { value: { text } } }),
      );
      const executed = await rejectionOf(
        execute(app, ChatStart, { text: "hi" }, { threadId: text }),
      );
      const cancelled = await rejectionOf(app.cancel(text));
      const tenant = await rejectionOf(
        execute(app, ChatStart, { text: "hi" }, { tenant: { tenantId: text } }),
      );

      expect(businessKey).toBeInstanceOf(InvalidBusinessKeyError);
      expect(businessKey).toMatchObject({ rule: expected });
      for (const thread of [executed, cancelled]) {
        expect(thread).toBeInstanceOf(InvalidThreadIdError);
        expect(thread).toMatchObject({ rule: expected });
      }
      expect(tenant).toBeInstanceOf(DtoValidationError);
      expect((tenant as Error).message).toContain(`(${expected})`);
    },
  );
});
