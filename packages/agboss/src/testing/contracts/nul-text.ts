/**
 * #521 AC4: the text a model or a tool may answer, as a store is handed it — a NUL character
 * (U+0000) among other control characters, a backslash escape spelled out (`\u0000` as six
 * characters) and a character outside the BMP. Every store gives back the text and JSON the
 * framework hands it unchanged, never losing nor rejecting it: PostgreSQL's `jsonb` and `text`
 * reject U+0000, so a store there keeps JSON as text, where U+0000 is the escape `\u0000`.
 */
export const NUL_TEXT = "before\u0000after \u0001\u001f \\u0000 spelled out, \u{1F600}";

/** The name of a suite's NUL case: `#521 AC4: <what> with a NUL character … reads back unchanged`. */
export const nulCaseName = (what: string): string =>
  `#521 AC4: ${what} with a NUL character (U+0000) reads back unchanged`;
