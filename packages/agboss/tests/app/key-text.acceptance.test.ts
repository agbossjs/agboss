/**
 * #538 acceptance — the corners the handoff's tables leave open:
 * - ids from the systems keys usually come from (UUIDs, ULIDs, Slack timestamps and channels,
 *   e-mail addresses, phone numbers, provider ids, URLs) stay keys and thread ids, the ZWJ-emoji
 *   refusal notwithstanding;
 * - the accepted side of every refused range's edge: a table one off at either end refuses it;
 * - a refused key never reaches a log entry or an observer event — at `app.execute` (a thread id)
 *   and inside a step (`fencedEffectKeyOf`, and a key built by hand at `OutboundCalls.send`) —
 *   and nothing runs under a refused thread id.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidThreadIdError, KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import { InvalidBusinessKeyError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  echoSeen,
  HandKeyedStart,
  KeyEchoApplication,
  KeyedEffectStart,
  resetEchoSeen,
} from "./fixtures/key-echo.application.js";
import { REFUSED_KEYS } from "./fixtures/key-texts.js";

/** Ids as the systems a business key or a thread id usually comes from write them. */
const COMMON_IDS: readonly (readonly [string, string])[] = [
  ["a UUID v4", "3f2b8c1e-9a4d-4f6b-8e2a-1c5d7e9f0a3b"],
  ["an upper-case UUID", "3F2B8C1E-9A4D-4F6B-8E2A-1C5D7E9F0A3B"],
  ["a ULID", "01HZX3K9Q4R7T2V8W6Y5Z0A1B3"],
  ["a Slack message ts", "1717171717.123456"],
  ["a Slack channel and thread ts", "C024BE91L/1717171717.123456"],
  ["a Slack user id", "U024BE7LH"],
  ["an e-mail address with a tag", "jane.doe+billing@example.com"],
  ["an internationalized e-mail address", "用户@例子.广告"],
  ["an E.164 phone number", "+972501234567"],
  ["a phone number with dashes", "+972-50-123-4567"],
  ["a Stripe payment intent", "pi_3NkZp2LkdIwHu7ix0aBcDeFg"],
  ["a Teams conversation id", "19:3f2b8c1e9a4d4f6b@thread.v2"],
  ["a WhatsApp chat id", "972501234567@c.us"],
  ["a Telegram supergroup id", "-1001234567890"],
  ["a URL with a query and a fragment", "https://shop.example.com/orders/42?x=1&y=%20#top"],
  ["a base64url token", "dGhpcyBpcyBhIHRva2Vu_-A"],
  ["a JSON-looking key", '{"order":42}'],
  ["a German key in NFC", "bestellung:größe-42"],
  ["a Vietnamese key in NFC", "đơn-hàng:42"],
  ["a Thai key (combining vowels, NFC)", "คำสั่งซื้อ:42"],
  ["an emoji without a joiner", "order:🧾42"],
];

/** The tightest naive rule a store might pick instead: identifiers only. */
const identifierOnly = (text: string): boolean => /^[A-Za-z0-9_-]+$/.test(text);

/** A key with `codePoint` in the middle. */
const around = (codePoint: number): string => `order:${String.fromCodePoint(codePoint)}42`;

/** The first code point after or before each refused range, accepted (none of Cc, Cf, Cs). */
const ACCEPTED_NEIGHBOURS: readonly (readonly [string, number])[] = [
  ["U+007E, right before DEL", 0x7e],
  ["U+00AC, right before the soft hyphen", 0xac],
  ["U+00AE, right after the soft hyphen", 0xae],
  ["U+0606, right after U+0600–U+0605", 0x606],
  ["U+061B, right before U+061C", 0x61b],
  ["U+06DC, right before U+06DD", 0x6dc],
  ["U+06DE, right after U+06DD", 0x6de],
  ["U+0710, right after U+070F", 0x710],
  ["U+08E3, right after U+08E2", 0x8e3],
  ["U+2010, right after U+200B–U+200F", 0x2010],
  ["U+2070, right after U+2066–U+206F", 0x2070],
  ["U+FFFC, right after U+FFF9–U+FFFB", 0xfffc],
  ["U+110BE, right after U+110BD", 0x110be],
  ["U+1D17B, right after U+1D173–U+1D17A", 0x1d17b],
];

/** Accepted code points near a refused range but not next to it. */
const ACCEPTED_NEARBY: readonly (readonly [string, number])[] = [
  ["U+00A1, two past C1", 0xa1],
  ["U+2030, two past U+202A–U+202E", 0x2030],
  ["U+FF01, past U+FEFF", 0xff01],
];

/** A table one off at both ends of every range: refuses a code point next to a refused one. */
const oneOffTable = (codePoint: number): boolean =>
  [codePoint - 1, codePoint, codePoint + 1].some(
    (near) => near >= 0 && keyTextRuleOf(`a${String.fromCodePoint(near)}`) !== undefined,
  );

describe("#538 acceptance: ids from the usual sources stay keys", () => {
  it.each(COMMON_IDS)("%s is a key and a thread id", (_label, text) => {
    expect(keyTextRuleOf(text)).toBeUndefined();
  });

  it("the identifier-only rule a store might use instead refuses most of them", () => {
    const refusedByNaive = COMMON_IDS.filter(([, text]) => !identifierOnly(text));

    expect(refusedByNaive.length).toBeGreaterThan(COMMON_IDS.length / 2);
  });
});

describe("#538 acceptance: the accepted side of each refused range's edge", () => {
  it.each([...ACCEPTED_NEIGHBOURS, ...ACCEPTED_NEARBY])("%s is a key", (_label, codePoint) => {
    expect(keyTextRuleOf(around(codePoint))).toBeUndefined();
  });

  it("a table one off at either end of a range refuses every one of them", () => {
    const missed = ACCEPTED_NEIGHBOURS.filter(([, codePoint]) => !oneOffTable(codePoint));

    expect(missed).toEqual([]);
  });
});

const app = testWith(KeyEchoApplication);

beforeEach(() => {
  resetEchoSeen();
  resetLogged();
});

/** Whether `seen` (log entries, events, an error) holds `text`, or its part after `order:`. */
const leaks = (seen: unknown, text: string): boolean => {
  const serialized = JSON.stringify(seen, (_key, value: unknown) =>
    value instanceof Error ? { message: value.message, ...value } : value,
  );
  const tail = text.startsWith("order:") ? text.slice("order:".length) : text;
  return [text, JSON.stringify(text).slice(1, -1), tail]
    .filter((part) => part.length >= 3)
    .some((part) => serialized.includes(part));
};

/** The refused keys long enough to be looked for in what was logged. */
const LOOKED_FOR = REFUSED_KEYS.filter(([, , text]) => text.length >= 7);

/**
 * The ones a step can be given: a lone surrogate is no JSON, so the start's input refuses it before
 * any step (`NonJsonValueError`, the text not named) — business-key-surrogate.test.ts keys one in code.
 */
const IN_A_STEP = LOOKED_FOR.filter(([, rule]) => rule !== KeyTextRule.LoneSurrogate);

describe("#538 acceptance: a refused thread id is in no log entry and no event, and nothing runs", () => {
  app.for(LOOKED_FOR)("%s (%s)", async ([, rule, text], { app: echo }) => {
    const error: unknown = await execute(
      echo,
      KeyedEffectStart,
      { text: "order:1" },
      { threadId: text, ownerId: "alice" },
    ).catch((thrown: unknown) => thrown);
    const again = await execute(
      echo,
      KeyedEffectStart,
      { text: "order:2" },
      { threadId: "after-the-refusal", ownerId: "bob" },
    );

    expect(error).toBeInstanceOf(InvalidThreadIdError);
    expect(error).toMatchObject({ rule });
    expect(leaks({ logged, events: echoSeen.events, error }, text)).toBe(false);
    expect(echoSeen.ran).toBe(1);
    expect(again.threadId).toBe("after-the-refusal");
  });
});

describe("#538 acceptance: a business key refused inside a step is in no log entry and no event", () => {
  for (const [path, start] of [
    ["fencedEffectKeyOf", KeyedEffectStart],
    ["a key built by hand at OutboundCalls.send", HandKeyedStart],
  ] as const) {
    app.for(IN_A_STEP)(`${path}: %s (%s)`, async ([, rule, text], { app: echo }) => {
      const error: unknown = await execute(echo, start, { text }).catch(
        (thrown: unknown) => thrown,
      );

      await expect(Promise.reject(error as Error)).rejects.toFailWith(InvalidBusinessKeyError, {
        rule,
      });
      expect(echoSeen.ran).toBe(0);
      const failures = echoSeen.events.filter(
        (event) => typeof event === "object" && event !== null && "error" in event,
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(leaks({ logged, failures, message: (error as Error).message }, text)).toBe(false);
    });
  }
});

describe("#538 acceptance: the leak check bites", () => {
  it("finds a key echoed in a message, in an event's error and in a JSON-escaped log", () => {
    const key = `order:${String.fromCodePoint(0x200b)}42`;

    expect(leaks({ message: `refused ${key}` }, key)).toBe(true);
    expect(leaks({ events: [{ error: new Error(`bad ${key}`) }] }, key)).toBe(true);
    expect(leaks([{ message: JSON.stringify(key) }], key)).toBe(true);
    expect(leaks({ message: `refused (${KeyTextRule.FormatCharacter})` }, key)).toBe(false);
  });
});

describe("#538 acceptance: a lone surrogate never reaches a step", () => {
  app(
    "the start's input refuses it, the text in no message, nothing runs",
    async ({ app: echo }) => {
      const text = "order:\uD800";

      const error: unknown = await execute(echo, KeyedEffectStart, { text }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(Error);
      expect(echoSeen.ran).toBe(0);
      expect(
        leaks({ logged, events: echoSeen.events, message: (error as Error).message }, text),
      ).toBe(false);
    },
  );
});
