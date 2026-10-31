/**
 * #538 AC2 — property tests (fast-check) of a business key's text on the core's stores, in memory
 * and on SQLite: every accepted key — any code points the rules let through, graphemes of every
 * script — comes back byte for byte, and two distinct accepted keys never meet in one row (an
 * outbound call's intent, a fenced effect's result). And for any text at all: refused exactly when
 * a rule says so, with an error that is the rule's own, never the text.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import {
  checkedBusinessKey,
  FencedEffectStatus,
  InvalidBusinessKeyError,
  type FencedEffectKey,
} from "../../src/index.js";
import {
  keyOf,
  leaseOf,
  writing,
  type FencedEffectStores,
} from "../../src/testing/contracts/fenced-effect-data.js";
import type { ContractTarget } from "../../src/testing/contracts/seam.js";
import { bytesOf } from "../../src/testing/contracts/key-text-data.js";
import { intentOf } from "../../src/testing/contracts/outbound-call-data.js";
import { withTarget } from "../../src/testing/contracts/seam.js";
import { inMemoryFencedEffects, sqliteFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls, sqliteOutboundCalls } from "./contracts/outbound-call-stores.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";
import { rewritingKeys } from "../fixtures/contracts/naive-guarantees.js";
import { seededProperties } from "../helpers/property-seed.js";

seededProperties("key-text.property.test.ts");

/**
 * What the rules refuse, to be mixed in: C1, Cf, lone surrogates, a combining mark after a base, a
 * space but U+0020 and the line and paragraph separators (#547), and what #556 refuses: characters
 * that render as nothing, private use, noncharacters, unassigned code points, the braille blank.
 */
const HAZARDS = [
  "\u00a0",
  "\u1680",
  "\u2007",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u3000",
  "  ",
  "\u0085",
  "\u009f",
  "\u00ad",
  "\u200b",
  "\u200d",
  "\u202e",
  "\u2066",
  "\ufeff",
  "\u{e0041}",
  "\ud800",
  "\udfff",
  "e\u0301",
  "\u212b",
  // #556
  "\u034f",
  "\ufe0f",
  "\u3164",
  "\u115f",
  "\u{e0100}",
  "\u2800",
  "\ufdd0",
  "\uffff",
  "\ue000",
  "\u{10fffd}",
  "\u0378",
];

/** A text with one hazard somewhere in it. */
const hazardous = fc
  .tuple(
    fc.string({ unit: "grapheme", maxLength: 20 }),
    fc.constantFrom(...HAZARDS),
    fc.string({ unit: "grapheme", maxLength: 20 }),
  )
  .map(([before, hazard, after]) => `${before}${hazard}${after}`);

/** Any text: code points of every plane (controls included), graphemes, and texts with a hazard. */
const anyText = fc.oneof(
  hazardous,
  fc.string({ unit: "binary", minLength: 0, maxLength: 80 }),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
  fc.string({ unit: "grapheme-composite", minLength: 1, maxLength: 20 }),
  fc.string({ unit: "binary-ascii", minLength: 0, maxLength: 210 }),
);

/** The keys the rules accept, of every kind `anyText` makes. */
const acceptedKey = anyText.filter((text) => keyTextRuleOf(text) === undefined);

/** The texts a lenient store or collation would take for `key`: case, width, spaces. */
const lookalikesOf = (key: string): readonly string[] =>
  [key, key.toUpperCase(), key.toLowerCase(), key.normalize("NFKC"), ` ${key}`, `${key} `].filter(
    (text) => keyTextRuleOf(text) === undefined,
  );

/**
 * A few distinct accepted keys — distinct as strings, so each must be its own row: random ones, or
 * one key with its look-alikes (another case, NFKC, a space), which a folding store would merge.
 */
const distinctKeys = fc.oneof(
  fc.uniqueArray(acceptedKey, { minLength: 1, maxLength: 6 }),
  acceptedKey.map((key) => [...new Set(lookalikesOf(key))]),
  fc.constant(["order:42", "Order:42", "ORDER:42", "order 42", "order:４２", "ｏｒｄｅｒ:42"]),
);

const STORE_RUNS = { inMemory: 100, sqlite: 40 } as const;

describe("#538 AC2: any text is refused exactly when a rule says so, never echoed", () => {
  it("a key is what no rule refuses: 1–200 code units, no Cc, no Cf, no Cs, no space but single inside U+0020s, no default-ignorable, private-use, unassigned or braille-blank code point, NFC", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const isKey =
          text.length >= 1 &&
          text.length <= 200 &&
          !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text) &&
          !/\p{Z}/u.test(text.replaceAll(" ", "")) &&
          // #556: nothing that renders as nothing, no private use, no unassigned code point
          // (noncharacters among them), no braille blank
          !/[\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\u2800]/u.test(text) &&
          !text.startsWith(" ") &&
          !text.endsWith(" ") &&
          !text.includes("  ") &&
          text.normalize("NFC") === text;
        expect(keyTextRuleOf(text) === undefined).toBe(isKey);
      }),
      { numRuns: 2000 },
    );
  });

  it("a refused key's error is its rule's own message, the same for every text", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const rule = keyTextRuleOf(text);
        const error = ((): unknown => {
          try {
            checkedBusinessKey({ name: "charge", businessKey: text });
            return undefined;
          } catch (thrown) {
            return thrown;
          }
        })();
        if (rule === undefined) expect(error).toBeUndefined();
        else {
          expect(error).toBeInstanceOf(InvalidBusinessKeyError);
          expect((error as Error).message).toBe(
            new InvalidBusinessKeyError({ name: "charge", rule }).message,
          );
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("two accepted keys are never one text under normalization: every NFD form of a key is refused", () => {
    fc.assert(
      fc.property(acceptedKey, (key) => {
        const decomposed = key.normalize("NFD");
        if (decomposed !== key) expect(keyTextRuleOf(decomposed)).toBe(KeyTextRule.NotNfc);
      }),
      { numRuns: 1000 },
    );
  });
});

/** The spaces a key may never hold (#547): Zs but U+0020, Zl, Zp. */
const OTHER_SPACES = [
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
];

/** `key` changed only by what #547 refuses: another space put in or swapped for one, or U+0020 at an edge or doubled. */
const spacedVariant = (key: string) =>
  fc.oneof(
    fc
      .tuple(fc.nat({ max: key.length }), fc.constantFrom(...OTHER_SPACES))
      .map(([at, space]) => `${key.slice(0, at)}${space}${key.slice(at)}`),
    fc.constantFrom(` ${key}`, `${key} `, ` ${key} `),
    fc.constantFrom(...OTHER_SPACES).map((space) => key.replaceAll(" ", space)),
    fc.constant(key.replaceAll(" ", "  ")),
  );

describe("#547 AC2: no accepted key differs from another only by a space the rules refuse", () => {
  it("another space put in or swapped for U+0020, a space at an edge, or a doubled one: refused", () => {
    fc.assert(
      fc.property(
        acceptedKey.chain((key) => fc.tuple(fc.constant(key), spacedVariant(key))),
        ([key, variant]) => {
          if (variant === key) return;
          expect(keyTextRuleOf(variant)).not.toBeUndefined();
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("a key of spaces only is refused: one, two, one beside another space", () => {
    expect(keyTextRuleOf(" ")).toBe(KeyTextRule.Spacing);
    expect(keyTextRuleOf("  ")).toBe(KeyTextRule.Spacing);
    expect(keyTextRuleOf("\u00a0")).toBe(KeyTextRule.SpaceSeparator);
    expect(keyTextRuleOf(" \u3000")).toBe(KeyTextRule.SpaceSeparator);
  });

  it("an accepted key with an interior space: every look-alike with another space is refused", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringMatching(/^[a-z0-9:]{1,10}$/),
          fc.stringMatching(/^[a-z0-9:]{1,10}$/),
          fc.constantFrom(...OTHER_SPACES),
        ),
        ([before, after, space]) => {
          expect(keyTextRuleOf(`${before} ${after}`)).toBeUndefined();
          expect(keyTextRuleOf(`${before}${space}${after}`)).toBe(KeyTextRule.SpaceSeparator);
          expect(keyTextRuleOf(`${before}  ${after}`)).toBe(KeyTextRule.Spacing);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

/** The outbound-call stores of a kind, in a target of the published seam. */
const CALL_TARGETS = [
  ["in-memory", inMemoryTarget(inMemoryOutboundCalls), STORE_RUNS.inMemory],
  ["SQLite", sqliteTarget(sqliteOutboundCalls), STORE_RUNS.sqlite],
] as const;

describe.each(CALL_TARGETS)("#538 AC2: outbound-call intents (%s)", (_kind, target, numRuns) => {
  it(
    "every accepted key comes back byte for byte on the other instance, and distinct keys are distinct intents",
    withTarget(target, async ({ first, second }) => {
      let round = 0;
      await fc.assert(
        fc.asyncProperty(distinctKeys, async (keys) => {
          round += 1;
          const lease = await leaseOf(first, `execution-${String(round)}`);
          const keyed = (businessKey: string): FencedEffectKey => ({
            ...keyOf(lease, `charge-${String(round)}`),
            businessKey,
          });
          for (const [index, businessKey] of keys.entries()) {
            const intent = intentOf(keyed(businessKey), { request: JSON.stringify({ index }) });
            expect(await first.calls.saveIfAbsent(keyed(businessKey), intent)).toBe(true);
          }
          for (const [index, businessKey] of keys.entries()) {
            const found = await second.calls.findByKey(keyed(businessKey));
            expect(bytesOf(found?.businessKey ?? "")).toEqual(bytesOf(businessKey));
            expect(found?.request).toBe(JSON.stringify({ index }));
          }
        }),
        { numRuns },
      );
    }),
  );
});

/** The fenced-effect property on `target`'s stores, whatever their transaction. */
function effectsProperty<TTransaction>(
  target: ContractTarget<FencedEffectStores<TTransaction>>,
  numRuns: number,
): () => Promise<void> {
  return withTarget(target, async ({ first, second }) => {
    let round = 0;
    await fc.assert(
      fc.asyncProperty(distinctKeys, async (keys) => {
        round += 1;
        const lease = await leaseOf(first, `execution-${String(round)}`);
        const keyed = (businessKey: string): FencedEffectKey => ({
          ...keyOf(lease, `charge-${String(round)}`),
          businessKey,
        });
        const count = { runs: 0 };
        for (const [index, businessKey] of keys.entries()) {
          const ran = await first.effects.saveResultIfAbsent(
            keyed(businessKey),
            writing(first.rows, `r${String(index)}`, count),
          );
          expect(ran.status).toBe(FencedEffectStatus.Ran);
        }
        for (const [index, businessKey] of keys.entries()) {
          const replayed = await second.effects.saveResultIfAbsent(
            keyed(businessKey),
            writing(second.rows, "never", count),
          );
          expect(replayed).toMatchObject({
            status: FencedEffectStatus.Replayed,
            result: { receipt: `r${String(index)}` },
          });
        }
        expect(count.runs).toBe(keys.length);
      }),
      { numRuns },
    );
  });
}

describe("#538 AC2: fenced effects", () => {
  const NAME =
    "distinct accepted keys each run once and replay their own result, on the other instance";
  it(
    `${NAME} (in-memory)`,
    effectsProperty(inMemoryTarget(inMemoryFencedEffects(false)), STORE_RUNS.inMemory),
  );
  it(`${NAME} (SQLite)`, effectsProperty(sqliteTarget(sqliteFencedEffects), STORE_RUNS.sqlite));
});

describe("#538 AC2: the property bites a store that folds a business key", () => {
  const folded = (fold: (businessKey: string) => string) =>
    inMemoryTarget((seam) => {
      const stores = inMemoryOutboundCalls(seam);
      const rewrite = (key: Record<string, unknown>) =>
        typeof key.businessKey === "string" ? { ...key, businessKey: fold(key.businessKey) } : key;
      return { ...stores, calls: rewritingKeys(stores.calls, seam.database, rewrite) };
    });

  it.each([
    ["a case-insensitive collation", (text: string) => text.toLowerCase()],
    ["NFKC", (text: string) => text.normalize("NFKC")],
  ] as const)(
    "%s: two distinct keys meet in one intent — the property fails",
    async (_fold, fold) => {
      const body = withTarget(folded(fold), async ({ first }) => {
        let round = 0;
        await fc.assert(
          fc.asyncProperty(distinctKeys, async (keys) => {
            round += 1;
            const lease = await leaseOf(first, `execution-${String(round)}`);
            for (const businessKey of keys) {
              const key = { ...keyOf(lease, `charge-${String(round)}`), businessKey };
              expect(await first.calls.saveIfAbsent(key, intentOf(key))).toBe(true);
            }
          }),
          { numRuns: STORE_RUNS.inMemory },
        );
      });

      await expect(body()).rejects.toThrow(/Property failed/u);
    },
  );

  it("#547: a trimming store merges no two accepted keys any more — no key has a space at an edge", () => {
    fc.assert(
      fc.property(acceptedKey, (key) => {
        expect(key.trim()).toBe(key);
      }),
      { numRuns: 2000 },
    );
  });
});
