/** At most this long: a thread id or a business key is a key, not data (#262 Q4, #508). */
const MAX_KEY_LENGTH = 200;

/**
 * The rules of a key's text (#538): a thread id, a business key and a tenant id identify a charge,
 * so two strings that look the same — to a person, or to the system that made them — must never be
 * two keys. An error names the rule, never the text; a text that breaks several is named by the
 * first of them in the order declared here (#547 acceptance), wherever in the text each breach
 * stands.
 */
export enum KeyTextRule {
  /** 1 to 200 UTF-16 code units. */
  Length = "length",
  /**
   * No half of a surrogate pair standing alone: no character. SQLite and PostgreSQL keep text as
   * UTF-8, where it becomes U+FFFD — two keys would be one row — and `encodeURIComponent` throws on it.
   */
  LoneSurrogate = "lone-surrogate",
  /** No control character: C0 (U+0000–U+001F), U+007F, C1 (U+0080–U+009F) — Unicode `Cc`. */
  ControlCharacter = "control-character",
  /**
   * No format character (Unicode `Cf`): zero-width space and joiners (U+200B–U+200D), marks and bidi
   * controls (U+200E–U+200F, U+202A–U+202E, U+2066–U+2069), U+FEFF, the soft hyphen, tag characters, …
   * — invisible, so "order:42" and "order:\u200B42" would be two charges of one order.
   */
  FormatCharacter = "format-character",
  /**
   * No space but U+0020 (#547): no other Unicode space separator (`Zs`: U+00A0, U+2000–U+200A,
   * U+202F, U+205F, U+3000, …), no line or paragraph separator (U+2028, U+2029) — "order 42" with a
   * no-break space looks like the one with a space.
   */
  SpaceSeparator = "space-separator",
  /**
   * U+0020 only single and inside (#547): none at the start or the end, never two in a row —
   * upstream systems differ in whether they trim and collapse spaces.
   */
  Spacing = "spacing",
  /**
   * No character Unicode says renders as nothing (#556, `Default_Ignorable_Code_Point`, whatever its
   * category): the combining grapheme joiner U+034F, the Hangul fillers (U+115F, U+1160, U+3164,
   * U+FFA0), the variation selectors (U+FE00–U+FE0F — the emoji ones too: "❤\uFE0F" is "❤" + U+FE0F —,
   * U+E0100–U+E01EF), the Mongolian free variation selectors, U+17B4 / U+17B5, and the code points
   * Unicode reserves as such — "order:4\u034F2" would be a second charge of "order:42".
   */
  Ignorable = "ignorable",
  /**
   * No private-use character (`Co`: U+E000–U+F8FF, planes 15 and 16) and no noncharacter
   * (U+FDD0–U+FDEF, U+xFFFE and U+xFFFF of every plane) (#556): no meaning a person or another
   * system shares — each font and each system renders, maps or drops them its own way.
   */
  PrivateOrNoncharacter = "private-or-noncharacter",
  /**
   * No code point unassigned in this runtime's Unicode (`Cn`, #556): a later runtime may make it a
   * format character or give it a decomposition, and refuse a key stored before a rolling upgrade.
   * Unassigned code points only become assigned as Unicode grows, so a key accepted now stays one.
   */
  Unassigned = "unassigned",
  /** No blank-looking symbol outside the property above (#556): U+2800 BRAILLE PATTERN BLANK. */
  Blank = "blank",
  /**
   * In Unicode normalization form C: "é" as U+00E9, never as "e" + U+0301. Refused, never normalized
   * silently — a key changed on its way in would no longer replay the effect stored under it.
   */
  NotNfc = "not-nfc",
}

/** What each rule asks, as an error says it (the text itself is never named). */
export const KEY_TEXT_RULE_TEXT: Readonly<Record<KeyTextRule, string>> = {
  [KeyTextRule.Length]: `it must be 1 to ${String(MAX_KEY_LENGTH)} characters (UTF-16 code units)`,
  [KeyTextRule.LoneSurrogate]: "it contains a lone surrogate (half of a UTF-16 pair, no character)",
  [KeyTextRule.ControlCharacter]:
    "it contains a control character (C0 U+0000–U+001F, U+007F or C1 U+0080–U+009F)",
  [KeyTextRule.FormatCharacter]:
    "it contains a format character (Unicode Cf: zero-width space or joiner, a bidi control, U+FEFF, a soft hyphen, …)",
  [KeyTextRule.SpaceSeparator]:
    "it contains a space other than U+0020 (Unicode Zs: a no-break, thin or ideographic space, …) or a line or paragraph separator (U+2028, U+2029)",
  [KeyTextRule.Spacing]:
    "it starts or ends with a space (U+0020), or has two in a row: a key's spaces are single and inside",
  [KeyTextRule.Ignorable]:
    "it contains a character that renders as nothing (Unicode Default_Ignorable_Code_Point: a variation selector, a Hangul filler, the combining grapheme joiner, …)",
  [KeyTextRule.PrivateOrNoncharacter]:
    "it contains a private-use character (Unicode Co) or a noncharacter (U+FDD0–U+FDEF, U+xFFFE, U+xFFFF)",
  [KeyTextRule.Unassigned]:
    "it contains a code point unassigned in this runtime's Unicode (Cn): a later version may give it another meaning",
  [KeyTextRule.Blank]: "it contains a blank-looking symbol (U+2800 BRAILLE PATTERN BLANK)",
  [KeyTextRule.NotNfc]:
    'it is not in Unicode normalization form C (NFC): normalize it with text.normalize("NFC") where it is made',
};

/** Whether `text` breaks one rule; the length aside. */
type Breach = (text: string) => boolean;

const matching =
  (pattern: RegExp): Breach =>
  (text) =>
    pattern.test(text);

/** Each rule but the length, in `KeyTextRule`'s order: the first one broken is named. */
const BREACHES: readonly (readonly [KeyTextRule, Breach])[] = [
  [KeyTextRule.LoneSurrogate, matching(/\p{Cs}/u)],
  [KeyTextRule.ControlCharacter, matching(/\p{Cc}/u)],
  [KeyTextRule.FormatCharacter, matching(/\p{Cf}/u)],
  // every space separator but U+0020, and the line and paragraph separators (#547)
  [KeyTextRule.SpaceSeparator, matching(/(?! )[\p{Zs}\p{Zl}\p{Zp}]/u)],
  // a space at an edge, or two in a row
  [KeyTextRule.Spacing, matching(/^ | $| {2}/u)],
  [KeyTextRule.Ignorable, matching(/\p{Default_Ignorable_Code_Point}/u)],
  // noncharacters are Cn too: named before the unassigned ones
  [KeyTextRule.PrivateOrNoncharacter, matching(/[\p{Co}\p{Noncharacter_Code_Point}]/u)],
  [KeyTextRule.Unassigned, matching(/\p{Cn}/u)],
  [KeyTextRule.Blank, matching(/⠀/u)],
  [KeyTextRule.NotNfc, (text) => text.normalize("NFC") !== text],
];

/**
 * The first rule of a key's text (#538, #547, #556) that `text` breaks, in `KeyTextRule`'s order;
 * `undefined` when it is a key.
 */
export function keyTextRuleOf(text: string): KeyTextRule | undefined {
  if (text.length === 0 || text.length > MAX_KEY_LENGTH) return KeyTextRule.Length;
  return BREACHES.find(([, breaks]) => breaks(text))?.[0];
}
