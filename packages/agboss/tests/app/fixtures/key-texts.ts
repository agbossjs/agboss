import { KeyTextRule } from "../../../src/errors.js";

/**
 * #538 — the texts of the key-text tables: every refused class (one sample per range and the
 * range's edges), NFC / NFD pairs, and accepted non-ASCII keys. `[label, rule, text]` and
 * `[label, text]`, as `it.each` takes them.
 */

const at = (codePoint: number): string => `order:${String.fromCodePoint(codePoint)}42`;
const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/** Every space but U+0020, and the line and paragraph separators (#547): Zs, Zl, Zp. */
const SPACES = [
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

/** C0, DEL and C1: their edges and a sample inside. */
const CONTROLS = [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f];

/** Unicode Cf: each block's edges and the zero-width, bidi and BOM characters the issue names. */
const FORMATS = [
  0x00ad, 0x0600, 0x0605, 0x061c, 0x06dd, 0x070f, 0x08e2, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e,
  0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068,
  0x2069, 0x206a, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0x110bd, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
  0xe0001, 0xe0020, 0xe007f,
];

export const REFUSED_KEYS: readonly (readonly [string, KeyTextRule, string])[] = [
  ["the empty text", KeyTextRule.Length, ""],
  ["201 characters", KeyTextRule.Length, "k".repeat(201)],
  ["101 emoji (202 code units)", KeyTextRule.Length, "🧾".repeat(101)],
  ...CONTROLS.map(
    (code) => [`control ${hex(code)}`, KeyTextRule.ControlCharacter, at(code)] as const,
  ),
  ...FORMATS.map((code) => [`format ${hex(code)}`, KeyTextRule.FormatCharacter, at(code)] as const),
  [
    "a family emoji joined by U+200D",
    KeyTextRule.FormatCharacter,
    `order:${["👨", "👩", "👧"].join(String.fromCodePoint(0x200d))}`,
  ],
  ...SPACES.map((code) => [`space ${hex(code)}`, KeyTextRule.SpaceSeparator, at(code)] as const),
  ["a leading space", KeyTextRule.Spacing, " order:42"],
  ["a trailing space", KeyTextRule.Spacing, "order:42 "],
  ["two spaces in a row", KeyTextRule.Spacing, "order  42"],
  ["three spaces in a row", KeyTextRule.Spacing, "order   42"],
  [
    "a space before a no-break space: the other space named first",
    KeyTextRule.SpaceSeparator,
    "order \u00a042",
  ],
  ["a high surrogate alone (U+D800)", KeyTextRule.LoneSurrogate, "order:\uD800"],
  ["a high surrogate alone (U+DBFF)", KeyTextRule.LoneSurrogate, "order:\uDBFF42"],
  ["a low surrogate alone (U+DC00)", KeyTextRule.LoneSurrogate, "order:\uDC0042"],
  ["a low surrogate alone (U+DFFF)", KeyTextRule.LoneSurrogate, "order:\uDFFF"],
  ["a pair the wrong way round", KeyTextRule.LoneSurrogate, "order:\uDC00\uD800"],
  ["an emoji cut in half", KeyTextRule.LoneSurrogate, "order:🧾42".slice(0, 7)],
  ["e + U+0301", KeyTextRule.NotNfc, "café"],
  ["the Angstrom sign U+212B", KeyTextRule.NotNfc, "order:Å"],
  ["the Ohm sign U+2126", KeyTextRule.NotNfc, "order:Ω"],
  ["Hangul jamo ᄀ + ᅡ", KeyTextRule.NotNfc, "order:가"],
  ["combining marks out of order", KeyTextRule.NotNfc, "á̧"],
];

export const ACCEPTED_KEYS: readonly (readonly [string, string])[] = [
  ["ASCII", "order:42"],
  ["one character", "k"],
  ["200 characters", "k".repeat(200)],
  ["100 emoji (200 code units)", "🧾".repeat(100)],
  ["a space and punctuation", "order 42/%:\"'\\"],
  ["U+0021 and U+007E, the edges of printable ASCII but the space", "!~"],
  ["a single space inside", "order 42"],
  ["single spaces inside, several", "order 42 of 7"],
  ["U+00A1, right after C1 and the no-break space", "¡"],
  ["U+2010, right after the spaces and the zero-width block", "‐"],
  ["CJK", "注文:四十二"],
  ["Japanese kana", "ちゅうもん:42"],
  ["Korean, NFC syllables", "주문:42"],
  ["Cyrillic", "заказ:42"],
  ["Greek", "παραγγελία:42"],
  ["Hebrew, right to left with no bidi control", "הזמנה:42"],
  ["Arabic", "طلب:42"],
  ["Devanagari", "ऑर्डर:42"],
  ["an emoji", "order:🧾42"],
  ["an emoji with a variation selector (Mn, not Cf)", "order:❤️"],
  ["a flag of regional indicators", "order:🇮🇱"],
  ["an emoji with a skin tone", "order:👍🏽"],
  ["é already NFC (U+00E9)", "café"],
  ["Å already NFC (U+00C5)", "order:Å"],
  ["a combining mark with no precomposed form", "q̇"],
  ["an astral CJK ideograph", "order:\u{20000}"],
];

/** One text as NFC and as NFD: the NFC form is a key, the NFD form is refused. */
export const NFC_PAIRS: readonly (readonly [string, string, string])[] = [
  ["café", "café", "café"],
  ["Ångström", "Ångström", "Ångström"],
  ["Ελλάδα", "Ελλάδα", "Ελλάδα"],
  ["가", "가", "가"],
  ["ñ", "ñ", "ñ"],
  ["Ḝ", "Ḝ", "Ḝ"],
];
