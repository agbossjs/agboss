/** #1007 AC1, AC2: the unmask state machine, at every split point, on code text and on made-up tokens. */
import { describe, expect, it } from "vitest";
import type { PiiTokenMap } from "../../src/pii/tokens.js";
import { Unmasker } from "../../src/run/stream/unmask.js";

const TOKEN = "<email:9cf08e>";
const KNOWN = { [TOKEN]: "alice@example.com", "<user-id:0a1b2c3d>": "u-17" };

/** What a consumer shows when the model writes `pieces` in this order. */
function shown(pieces: readonly string[], tokens: PiiTokenMap = KNOWN): string {
  const unmask = new Unmasker(tokens);
  return pieces.map((piece) => unmask.push(piece)).join("") + unmask.end();
}

describe("#1007 AC1: a token is revealed once complete", () => {
  const text = `Write to ${TOKEN} now, ${TOKEN}.`;
  const revealed = "Write to alice@example.com now, alice@example.com.";

  it("whole, one character at a time, and cut in two at every split point", () => {
    expect(shown([text])).toBe(revealed);
    expect(shown(Array.from(text))).toBe(revealed);
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(shown([text.slice(0, cut), text.slice(cut)]), `cut at ${String(cut)}`).toBe(revealed);
    }
  });

  it("cut in three at every pair of split points", () => {
    for (let first = 0; first <= text.length; first += 1) {
      for (let second = first; second <= text.length; second += 1) {
        const pieces = [text.slice(0, first), text.slice(first, second), text.slice(second)];
        expect(shown(pieces), `cuts at ${String(first)}, ${String(second)}`).toBe(revealed);
      }
    }
  });

  it("holds nothing back that cannot be a token: a < costs one character", () => {
    const unmask = new Unmasker(KNOWN);
    expect(unmask.push("if (a <")).toBe("if (a ");
    expect(unmask.push(" b)")).toBe("< b)");
  });

  it("a > after a token is text", () => {
    expect(shown([`${TOKEN}>`])).toBe("alice@example.com>");
  });

  it("a field's token is a token like any other", () => {
    expect(shown(["user <user-id:0a1b2c3d> asked"])).toBe("user u-17 asked");
  });
});

describe("#1007: text that is no token is shown as written", () => {
  for (const code of [
    "if (a < b) { return x<y; }",
    "<div>text</div>",
    "a<b>c",
    "<email:zz>",
    "<email:9cf0>",
    "<Email:9cf08e>",
    "<email:9cf08e",
    "tail <",
    "<",
    "<<<",
    `<email:${"a".repeat(65)}>`,
    `<${"a".repeat(200)}`,
    "<1abc:123456>",
    "<email :9cf08e>",
  ]) {
    it(`${code.slice(0, 40)} stays`, () => {
      expect(shown([code])).toBe(code);
      expect(shown(Array.from(code))).toBe(code);
    });
  }

  it("a second < inside a candidate starts a new one", () => {
    expect(shown([`<<email:9cf08e>`])).toBe("<alice@example.com");
    expect(shown([`<em<email:9cf08e>`])).toBe("<emalice@example.com");
  });

  it("an unclosed candidate at the end of the turn is text", () => {
    const unmask = new Unmasker(KNOWN);
    expect(unmask.push("see <email:9c")).toBe("see ");
    expect(unmask.end()).toBe("<email:9c");
    expect(unmask.end()).toBe("");
  });

  it("never holds more than the longest token", () => {
    const unmask = new Unmasker(KNOWN);
    const out = unmask.push(`<${"a".repeat(120)}`);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThanOrEqual(96);
  });
});

describe("#1007 AC2: a hallucinated token is never shown as written", () => {
  it("it becomes its kind, whichever way it is cut", () => {
    const text = "Mail <email:abcdef12> or <person-name:00ff00ff>.";
    expect(shown([text])).toBe("Mail <email> or <person-name>.");
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(shown([text.slice(0, cut), text.slice(cut)])).toBe("Mail <email> or <person-name>.");
    }
  });

  it("a token another execution minted is unknown here", () => {
    expect(shown(["<email:9cf08e>"], {})).toBe("<email>");
  });
});
