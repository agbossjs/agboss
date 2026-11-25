/** #120 AC5: the actions do what their names say; one-way actions are never stored. */
import { describe, expect, it } from "vitest";
import { PiiAction, PiiKind, type PiiPolicyHandler } from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { PiiPolicy } from "../../src/pii/pii-policy.decorator.js";
import { maskedText, withoutOverlaps, type PiiFinding } from "../../src/pii/masking.js";
import { partReplaced } from "../../src/pii/replacement.js";
import { mergeTokens, revealedText, tokenOf } from "../../src/pii/tokens.js";
import { actionText, isSameAction, type AnyPiiAction } from "../../src/pii/actions.js";

const finding = (
  text: string,
  value: string,
  action: AnyPiiAction,
  label = "email",
): PiiFinding => {
  const start = text.indexOf(value);
  return { start, end: start + value.length, label, action, policy: "p", key: "k", rank: 0 };
};

describe("#120 AC5: actions", () => {
  it("mask() → <israeli-id>, one-way", () => {
    const text = "id 000000018";
    const action = PiiAction.mask();
    const result = maskedText(text, [finding(text, "000000018", action, PiiKind.IsraeliId.id)], {});
    expect(result).toEqual({ text: "id <israeli-id>", tokens: {}, blocked: [] });
  });

  it("mask({ keep… }) keeps what it names", () => {
    expect(partReplaced("4242 4242 4242 4242", { keepLast: 4 })).toBe("•••• 4242");
    expect(partReplaced("dana@acme.com", { keepDomain: true })).toBe("d•••@acme.com");
    expect(partReplaced("+1 555 123 4542", { keepFirst: 2, keepLast: 2 })).toBe("+1•••• 42");
    expect(partReplaced("abc", { keepFirst: 2, keepLast: 2 })).toBe("••••");
    expect(partReplaced("no-at-sign", { keepDomain: true })).toBe("••••");
  });

  it("mask({ pattern }) replaces every match", () => {
    expect(partReplaced("AB-1234-CD", { pattern: /\d{4}/ })).toBe("AB-••••-CD");
    expect(partReplaced("1 and 2", { pattern: /\d/g })).toBe("•••• and ••••");
  });

  it("tokenize() → one HMAC token per value, revealed only by the map", () => {
    const text = "alice@example.com and Alice@Example.com";
    const findings = [
      finding(text, "alice@example.com", PiiAction.tokenize()),
      { ...finding(text, "Alice@Example.com", PiiAction.tokenize()), start: 22, end: 39 },
    ];
    const result = maskedText(text, findings, {});
    const [token] = Object.keys(result.tokens);
    expect(result.text).toBe(`${token ?? ""} and ${token ?? ""}`);
    expect(revealedText(result.text, result.tokens).text).toBe(
      "alice@example.com and alice@example.com",
    );
    expect(tokenOf("email", "alice@example.com", "k", {})).toBe(token);
    expect(tokenOf("email", "alice@example.com", "other-key", {})).not.toBe(token);
  });

  it("a token prefix taken by another value grows until it is unique", () => {
    const short = tokenOf("email", "a@b.io", "k", {});
    const longer = tokenOf("email", "a@b.io", "k", { [short]: "other@x.io" });
    expect(longer).toMatch(/^<email:[0-9a-f]{8}>$/);
    expect(longer.startsWith(short.slice(0, -1))).toBe(true);
  });

  it("block: the value is shown as <kind> and reported", () => {
    const text = "card 4111";
    const action = PiiAction.block("No cards.");
    const result = maskedText(text, [finding(text, "4111", action, "card-number")], {});
    expect(result.text).toBe("card <card-number>");
    expect(result.blocked).toHaveLength(1);
    expect(actionText(action)).toBe('block("No cards.")');
    expect(actionText(PiiAction.block())).toBe("block()");
  });

  it("an unknown token stays and is listed", () => {
    expect(revealedText("to <email:abcdef>", {})).toEqual({
      text: "to <email:abcdef>",
      unknownTokens: ["<email:abcdef>"],
    });
  });

  it("overlaps: the longest wins, then the more specific detector", () => {
    const text = "0123456789";
    const long = { ...finding(text, "0123456789", PiiAction.mask(), "phone"), rank: 5 };
    const short = { ...finding(text, "01234", PiiAction.mask(), "us-ssn"), rank: 1 };
    const tie = { ...long, label: "card-number", rank: 2 };
    expect(withoutOverlaps([short, long]).map((item) => item.label)).toEqual(["phone"]);
    expect(withoutOverlaps([long, tie]).map((item) => item.label)).toEqual(["card-number"]);
  });

  it("maps merge by key (branches, children)", () => {
    expect(mergeTokens({ "<email:aaaaaa>": "a@b.io" }, { "<email:bbbbbb>": "c@d.io" })).toEqual({
      "<email:aaaaaa>": "a@b.io",
      "<email:bbbbbb>": "c@d.io",
    });
  });

  it("two actions are the same when their kind and options are", () => {
    expect(isSameAction(PiiAction.mask({ keepLast: 4 }), PiiAction.mask({ keepLast: 4 }))).toBe(
      true,
    );
    expect(isSameAction(PiiAction.mask({ keepLast: 4 }), PiiAction.mask({ pattern: /x/ }))).toBe(
      false,
    );
  });
});

describe("#120 AC5 / AC13: what does not compile", () => {
  it("keep and pattern together, a block action on a field or in a project's detector", () => {
    // @ts-expect-error — either what to keep or what to replace, never both
    PiiAction.mask({ keepLast: 4, pattern: /x/ });

    class Holder {
      // @ts-expect-error — a field's `sensitive` takes a masking action only
      @Text({ sensitive: PiiAction.block() })
      name!: string;
    }

    // @ts-expect-error — a project's detector applies a masking action only
    @PiiPolicy({ name: "x-pii-policy", action: PiiAction.block() })
    class BlockingDetector implements PiiPolicyHandler {
      findMatches(): [] {
        return [];
      }
    }

    expect([Holder, BlockingDetector]).toHaveLength(2);
  });
});
