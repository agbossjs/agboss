/**
 * #538 acceptance: the key-text cases bite. A store that folds a business key on its way in — a
 * case-insensitive collation, NFKC, a trim — makes two keys one row, and fails the round-trip case;
 * one that cleans a key of what the rules refuse takes a key it must refuse, and fails the
 * refusal case. The rule before #538 (length, C0 controls, lone surrogates) accepts what the
 * tables refuse: C1 controls, format characters, NFD.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { KeyTextRule } from "../../../src/errors.js";
import { REFUSED_KEYS } from "../../app/fixtures/key-texts.js";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "naive-key-text.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 120_000);

/** The #538 cases of `target`'s suite and their states. */
const statesOf = (target: string) =>
  run.cases
    .filter((found) => found.suites[0]?.endsWith(`(${target})`) === true)
    .filter((found) => found.name.startsWith("#538:"))
    .map((found) => [found.name.slice(0, 40), found.state] as const);

const ROUND_TRIP = "#538: business keys of many scripts — CJ";
const REFUSAL = "#538: a key built by hand whose business";

describe("#538 AC2: a store that folds or cleans a business key fails the key-text cases", () => {
  it.each(["a case-insensitive collation", "keys folded to NFKC"])(
    "%s: two keys become one row — the round-trip case fails, for effects and calls",
    (fold) => {
      for (const kind of ["effects", "calls"]) {
        expect(statesOf(`${kind} with ${fold}`)).toContainEqual([ROUND_TRIP, "fail"]);
      }
    },
  );

  it("#547: a store that trims keys merges no accepted key, but takes one with an edge space it must refuse — the refusal case fails", () => {
    for (const kind of ["effects", "calls"]) {
      expect(statesOf(`${kind} with keys trimmed`)).toContainEqual([ROUND_TRIP, "pass"]);
      expect(statesOf(`${kind} with keys trimmed`)).toContainEqual([REFUSAL, "fail"]);
    }
  });

  it("a store that cleans a key takes one it must refuse — the refusal case fails, for effects and calls", () => {
    const fold = "keys cleaned of controls and format characters, then NFC";
    for (const kind of ["effects", "calls"]) {
      expect(statesOf(`${kind} with ${fold}`)).toContainEqual([REFUSAL, "fail"]);
    }
  });
});

/** The rule of a key's text before #538: 1–200 characters, no C0 control or DEL, no lone surrogate. */
const isKeyBefore538 = (text: string): boolean => {
  if (text.length === 0 || text.length > 200 || /\p{Cs}/u.test(text)) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
};

describe("#538 AC1: the tables bite the rule before #538", () => {
  it("it accepts every C1 control, format character and NFD sample the tables refuse", () => {
    const newlyRefused = REFUSED_KEYS.filter(([, rule]) =>
      [KeyTextRule.ControlCharacter, KeyTextRule.FormatCharacter, KeyTextRule.NotNfc].includes(
        rule,
      ),
    ).filter(
      ([, rule, text]) =>
        rule !== KeyTextRule.ControlCharacter || (text.codePointAt(6) ?? 0) >= 0x80,
    );

    expect(newlyRefused.length).toBeGreaterThan(40);
    for (const [label, , text] of newlyRefused)
      expect({ label, accepted: isKeyBefore538(text) }).toEqual({ label, accepted: true });
  });
});
