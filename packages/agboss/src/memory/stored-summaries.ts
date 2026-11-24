/**
 * How a custom compaction's summaries are stored (#382): its `compact()` gives a list, kept as one
 * summary record whose text is that list as JSON, so the list a reader sees is always the last one
 * given, in its order. A text that is not such a list is one summary.
 */

const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The summaries of one stored record of a custom compaction. */
export function summaryTextsOf(text: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(text);
    return isTextList(value) ? value : [text];
  } catch {
    return [text];
  }
}
