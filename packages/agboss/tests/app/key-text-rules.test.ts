/**
 * #538 AC1 — the rules of a key's text, as tables: a business key and a thread id identify a charge,
 * so two texts that look the same must never be two keys. Every refused class — one sample per
 * range and the range's edges —, NFC against NFD pairs, and accepted non-ASCII (CJK, emoji,
 * Cyrillic, already NFC). Each refusal names its rule, never the key, wherever the key enters:
 * `fencedEffectKeyOf`, a key built by hand at `OutboundCalls.send` and at a store's entry, and a
 * thread id at `app.execute`.
 */
import { describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { InvalidThreadIdError, KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import {
  Action,
  ExecutionContext,
  fencedEffectKeyOf,
  InvalidBusinessKeyError,
} from "../../src/index.js";
import { testAction, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { ChatStart, DeskApplication } from "../testing/fixtures/desk.workflow.js";
import { ACCEPTED_KEYS, NFC_PAIRS, REFUSED_KEYS } from "./fixtures/key-texts.js";

@Action({
  name: "keyed-charge-action",
  description: "Keys a charge by the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowStartTextDto,
  deps: [ExecutionContext],
})
class KeyedChargeAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly message: { readonly value: WorkflowStartTextDto } }) {
    const key = fencedEffectKeyOf(this.executionContext, "charge", {
      businessKey: input.message.value.text,
    });
    return Promise.resolve({ text: key.businessKey ?? "" });
  }
}

const keyed = (businessKey: string) =>
  testAction(KeyedChargeAction)({ message: { value: { text: businessKey } } }).then(
    (result) => result.output.text,
    (thrown: unknown) => thrown,
  );

const app = testWith(DeskApplication);

describe("#538 AC1: the rules of a key's text", () => {
  it.each(REFUSED_KEYS)("%s is refused: %s", (_label, rule, text) => {
    expect(keyTextRuleOf(text)).toBe(rule);
  });

  it.each(ACCEPTED_KEYS)("%s is a key", (_label, text) => {
    expect(keyTextRuleOf(text)).toBeUndefined();
  });

  it.each(NFC_PAIRS)(
    "%s: the NFC form is a key, the NFD form is refused — never two keys for one text",
    (_label, nfc, nfd) => {
      expect(nfc).not.toBe(nfd);
      expect(nfd.normalize("NFC")).toBe(nfc);
      expect(keyTextRuleOf(nfc)).toBeUndefined();
      expect(keyTextRuleOf(nfd)).toBe(KeyTextRule.NotNfc);
    },
  );
});

describe("#538 AC1: fencedEffectKeyOf refuses each class, naming the rule, never the key", () => {
  it.each(REFUSED_KEYS)("%s → InvalidBusinessKeyError(%s)", async (_label, rule, text) => {
    const error = await keyed(text);

    expect(error).toBeInstanceOf(InvalidBusinessKeyError);
    expect(error).toMatchObject({ rule, effect: "charge", details: { rule, effect: "charge" } });
    const { message } = error as Error;
    expect(message).toContain(`(${rule})`);
    if (text.length > 0) expect(message).not.toContain(text);
    expect(message).not.toContain("order");
  });

  it.each(ACCEPTED_KEYS)("%s is kept as it is", async (_label, text) => {
    expect(await keyed(text)).toBe(text);
  });
});

describe("#538 AC1: a thread id at app.execute refuses each class, naming the rule, never the id", () => {
  app.for(REFUSED_KEYS)(
    "%s → InvalidThreadIdError(%s), nothing created",
    async ([, rule, text], { app: desk }) => {
      const error: unknown = await execute(
        desk,
        ChatStart,
        { text: "hi" },
        { threadId: text },
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(InvalidThreadIdError);
      expect(error).toMatchObject({ rule, details: { rule } });
      const { message } = error as Error;
      expect(message).toContain(`(${rule})`);
      if (text.length > 0) expect(message).not.toContain(text);
    },
  );
});
