import { KeyTextRule } from "../../core/errors.js";

/**
 * Business keys for the key-text cases (#538) of the fenced-effect and outbound-call contracts: keys
 * of many scripts and planes that must come back unchanged and never meet another key's row, and a
 * key breaking each rule (#547: a space but U+0020, a space at an edge or doubled; #556: a character
 * that renders as nothing, a private-use one or a noncharacter, an unassigned one, the braille
 * blank), which every
 * store method refuses before any statement.
 */

/**
 * Accepted keys — none the NFC, case or width form of another — each its own row; and (#620) keys
 * an accent-insensitive collation equates ("café" and "cafe", "q̇" and "q", "straße" and
 * "strasse": MySQL's `_ai_ci`, an ICU strength-1 collation, `unaccent`), each its own row too.
 */
export const ROUND_TRIP_KEYS: readonly string[] = [
  "order:42",
  "order 42",
  "Order:42",
  "order:４２",
  "注文:四十二",
  "заказ:42",
  "הזמנה:42",
  "طلب:42",
  "order:🧾42",
  "order:\u2764",
  "order:🇮🇱",
  "order:\u{20000}",
  "café",
  "cafe",
  "q̇",
  "q",
  "order:straße",
  "order:strasse",
  "%3A:%:'\"\\",
  "k".repeat(200),
  "🧾".repeat(100),
];

/** A key breaking each rule, with the rule: what a key built by hand might carry. */
export const REFUSED_BUSINESS_KEYS: readonly (readonly [KeyTextRule, string])[] = [
  [KeyTextRule.Length, "k".repeat(201)],
  [KeyTextRule.ControlCharacter, `order:${String.fromCodePoint(0x85)}42`],
  [KeyTextRule.FormatCharacter, `order:${String.fromCodePoint(0x200b)}42`],
  [KeyTextRule.LoneSurrogate, "order:\uD83E"],
  [KeyTextRule.SpaceSeparator, `order:${String.fromCodePoint(0xa0)}42`],
  [KeyTextRule.SpaceSeparator, `order:${String.fromCodePoint(0x2028)}42`],
  [KeyTextRule.Spacing, "order:42 "],
  [KeyTextRule.Spacing, "order  42"],
  [KeyTextRule.NotNfc, "café"],
];

/** The UTF-8 bytes of `text`, as a store must keep them. */
export const bytesOf = (text: string): readonly number[] => [...new TextEncoder().encode(text)];
