/**
 * What a free-text reply may change of the call it approves (#688, security review): the call's own
 * fields only, never above them — `correctionRefusalOf`.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A text that reads as a number: `"900"`, `"-1.5"`. */
const NUMERIC_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/u;

/** A value of another kind than the call's: no correction of it. */
const otherKind = (path: string): string => `${path} is not the call's kind of value`;

/** A value above the call's own: a raise. */
const raise = (path: string): string => `the reply would raise ${path} above the call's own`;

/** The first refusal of a list of values, `undefined` when none. */
function firstRefusalOf(
  entries: Iterable<readonly [string, unknown]>,
  ownOf: (key: string) => unknown,
  path: string,
  has: (key: string) => boolean,
): string | undefined {
  for (const [key, item] of entries) {
    if (!has(key)) return `${path}.${key} is new: the call has no such field`;
    const why = valueRefusalOf(item, ownOf(key), `${path}.${key}`);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** A list: the same length as the call's, item by item. */
function listRefusalOf(value: unknown, own: readonly unknown[], path: string): string | undefined {
  if (!Array.isArray(value)) return otherKind(path);
  if (value.length !== own.length) return `${path} is a list of another length than the call's`;
  const items = value.map((item, index): readonly [string, unknown] => [String(index), item]);
  return firstRefusalOf(
    items,
    (key) => own[Number(key)],
    path,
    () => true,
  );
}

/** An object: only the call's fields, each in turn. */
function recordRefusalOf(
  value: unknown,
  own: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  if (!isRecord(value)) return otherKind(path);
  return firstRefusalOf(
    Object.entries(value),
    (key) => own[key],
    path,
    (key) => Object.hasOwn(own, key),
  );
}

/** A text: changes freely, unless it reads as a number — then as a number, never raised. */
function textRefusalOf(value: string, own: string, path: string): string | undefined {
  const isNumeric = NUMERIC_TEXT.test(value);
  if (!NUMERIC_TEXT.test(own))
    return isNumeric ? `${path} reads as a number where the call's is text` : undefined;
  if (!isNumeric) return otherKind(path);
  return Number(value) > Number(own) ? raise(path) : undefined;
}

/** A number: finite, never above the call's own. */
const numberRefusalOf = (value: number, own: number, path: string): string | undefined => {
  if (!Number.isFinite(value)) return `${path} is not a finite number`;
  return value > own ? raise(path) : undefined;
};

/** A flag: only turned off. */
const flagRefusalOf = (value: boolean, own: boolean, path: string): string | undefined =>
  value && !own ? raise(path) : undefined;

/** A value that is no list or object: by its kind, which must be the call's. */
function primitiveRefusalOf(value: unknown, own: unknown, path: string): string | undefined {
  if (typeof value === "number" && typeof own === "number")
    return numberRefusalOf(value, own, path);
  if (typeof value === "string" && typeof own === "string") return textRefusalOf(value, own, path);
  if (typeof value === "boolean" && typeof own === "boolean")
    return flagRefusalOf(value, own, path);
  return value === own ? undefined : otherKind(path);
}

/** Why one value of a correction is no correction of the call's own (#688); `undefined`: it is one. */
function valueRefusalOf(value: unknown, own: unknown, path: string): string | undefined {
  if (Array.isArray(own)) return listRefusalOf(value, own, path);
  if (isRecord(own)) return recordRefusalOf(value, own, path);
  return primitiveRefusalOf(value, own, path);
}

/**
 * Why a correction cannot be read from a reply (#688, fail closed): a reply's limit lowers a value,
 * and a model that "applies" a limit above the call raises it — money the approver never asked to
 * spend. So a correction may change only fields the call already has (nested ones too), each to a
 * value of the same kind no greater than the call's own: numbers compared as numbers (a number
 * written as text only where the call's is such a text), a flag only turned off, a list of the same
 * length item by item; text may change. Anything else — a raise, a new field, another kind of
 * value — is not understood: decided, never read. `undefined` when the correction may stand.
 */
export function correctionRefusalOf(answer: unknown, ask: unknown): string | undefined {
  if (!isRecord(answer) || answer.overrideArguments === undefined) return undefined;
  const asked = isRecord(ask) && isRecord(ask.arguments) ? ask.arguments : {};
  if (!isRecord(answer.overrideArguments)) return "the correction is not the call's arguments";
  for (const [field, value] of Object.entries(answer.overrideArguments)) {
    if (!Object.hasOwn(asked, field)) return `${field} is new: the call has no such field`;
    const why = valueRefusalOf(value, asked[field], field);
    if (why !== undefined) return why;
  }
  return undefined;
}
