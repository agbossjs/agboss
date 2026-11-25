import { AGBossError } from "./errors.js";

/** What a refusal knows: the record, its ids and the failing fields — never a value. */
export interface StoredNamesUnreadableErrorOptions {
  readonly record: string;
  readonly ids: string;
  readonly fields: string;
  readonly cause?: unknown;
  /** The text is no JSON at all (#1121): the message says so, not "the field(s) … missing". */
  readonly isNotJson?: boolean;
}

/**
 * One meaning per name (#934): a store reads only the 0.1.1 shape and returns the value the schema
 * parsed, never the input. The schemas of the stored shapes do it (`PauseAnswerRecordSchema`,
 * `StoredPause`, the history record's): a value of any other shape — a 0.1.0 name, a missing field —
 * is refused with `StoredNamesUnreadableError`, naming the record's id and the field, never a value.
 * Nothing is migrated and no old name is read.
 */
export class StoredNamesUnreadableError extends AGBossError {
  static override readonly code = "stored.unreadable" as const;
  declare readonly code: typeof StoredNamesUnreadableError.code;
  override name = "StoredNamesUnreadableError";
  /** What was stored: `pause`, `pause answer`, `execution history record`. */
  declare readonly record: string;
  /** The ids that name it (`pauseId p1, executionId run-1`); empty when none is readable. */
  declare readonly ids: string;
  /** The field paths that failed (`pauses.0.respondent`) — never a value. */
  declare readonly fields: string;

  constructor(options: StoredNamesUnreadableErrorOptions) {
    const { record, ids, fields, cause, isNotJson } = options;
    const why =
      isNotJson === true
        ? "the text is not valid JSON"
        : `the field(s) ${fields} missing or not what the framework wrote`;
    super(`a stored ${record} is not readable${ids === "" ? "" : ` (${ids})`}: ${why}`, { cause });
    Object.assign(this, { record, ids, fields });
  }
}

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
 * that fails its schema is — `StoredNamesUnreadableError`, `what` and `ids` (the store's own keys of
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
    throw new StoredNamesUnreadableError({
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
