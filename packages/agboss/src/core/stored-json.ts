import { StoreError } from "./error-families/store-errors.js";

/**
 * The cause of a text that is no JSON: a parser's own message quotes the text it failed on
 * (`startInput`, the caller's PII, #906 D4), so the cause keeps only what is no content — that it
 * is no JSON, and where the parser stopped.
 */
function noJsonCause(parseError: unknown): SyntaxError {
  const position = /at position (\d+)/.exec(
    parseError instanceof Error ? parseError.message : "",
  )?.[1];
  return new SyntaxError(
    `the text is not valid JSON${position === undefined ? "" : ` (at position ${position})`}`,
  );
}

/**
 * The text a store kept as JSON (#1121), or unreadable: a text that is no JSON is refused as a value
 * that fails its schema is — `StoreError.UnreadableRecord`, `what` and `ids` (the store's own keys of
 * the row, `undefined` ones left out) named, never the text. The `cause` is a `SyntaxError` of the
 * parse without the text the parser quotes.
 */
export function parsedStoredJson(options: {
  /** What the text is (`"outbound call record"`), as an error names it. */
  readonly what: string;
  readonly text: string;
  /** The store's own keys of the row, `undefined` ones left out of the error; none → no ids. */
  readonly ids?: Readonly<Record<string, string | undefined>>;
  readonly reviver?: (key: string, value: unknown) => unknown;
}): unknown {
  const { what, text, ids = {}, reviver } = options;
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch (error) {
    throw new StoreError.UnreadableRecord({
      record: what,
      ids: Object.entries(ids)
        .flatMap(([key, id]) => (id === undefined ? [] : [`${key} ${id}`]))
        .join(", "),
      fields: "(the text)",
      cause: noJsonCause(error),
      isNotJson: true,
    });
  }
}
