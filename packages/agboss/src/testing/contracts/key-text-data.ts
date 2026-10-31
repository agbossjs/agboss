import { KeyTextRule } from "../../core/errors.js";

/**
 * Business keys for the key-text cases (#538) of the fenced-effect and outbound-call contracts: keys
 * of many scripts and planes that must come back unchanged and never meet another key's row, and a
 * key breaking each rule, which every store method refuses before any statement.
 */

/** Accepted keys — none the NFC, case or width form of another — each its own row. */
export const ROUND_TRIP_KEYS: readonly string[] = [
  "order:42",
  "order:42 ",
  "Order:42",
  "order:４２",
  "注文:四十二",
  "заказ:42",
  "הזמנה:42",
  "طلب:42",
  "order:🧾42",
  "order:❤️",
  "order:🇮🇱",
  "order:\u{20000}",
  "café",
  "q̇",
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
  [KeyTextRule.NotNfc, "café"],
];

/** The UTF-8 bytes of `text`, as a store must keep them. */
export const bytesOf = (text: string): readonly number[] => [...new TextEncoder().encode(text)];
