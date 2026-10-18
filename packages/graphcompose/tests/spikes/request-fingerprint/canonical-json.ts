/**
 * Spike #115 — RFC 8785 (JSON Canonicalization Scheme) for the values a fingerprint hashes.
 *
 * Differences from `JSON.stringify` + sorted keys that matter for a stable hash:
 * - keys are sorted by UTF-16 code units (`<` on strings), never `localeCompare` — collation
 *   depends on the process locale (en: "t" < "z"; et: "z" < "t");
 * - non-finite numbers, lone surrogates, `undefined` in arrays, functions, symbols, bigints and
 *   non-plain objects (Map, Set, class instances) are errors, not silently `null` / `{}`;
 * - `undefined` object properties are absent (a field not sent is not a field sent as `null`).
 * Numbers use the ECMAScript shortest round-trip form, which RFC 8785 adopts verbatim.
 */

/** A value that has exactly one canonical JSON form. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/** The canonical JSON text of a value — the bytes that get hashed. */
export type CanonicalJson = string & { readonly __canonical: true };

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

const LONE_SURROGATE = /\p{Surrogate}/u;

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError(`${path}: lone surrogate is not valid I-JSON`);
  }
  return JSON.stringify(value);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value))
    throw new CanonicalJsonError(`${path}: ${String(value)} is not JSON`);
  return Object.is(value, -0) ? "0" : String(value);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeArray(value: readonly unknown[], path: string): string {
  const items = value.map((item, index) => {
    if (item === undefined) throw new CanonicalJsonError(`${path}[${String(index)}]: undefined`);
    return serialize(item, `${path}[${String(index)}]`);
  });
  return `[${items.join(",")}]`;
}

function serializeObject(value: object, path: string): string {
  if (!isPlainObject(value)) {
    throw new CanonicalJsonError(`${path}: ${value.constructor.name} is not a plain object`);
  }
  const members = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => byCodeUnits(a, b))
    .map(([key, item]) => `${serializeString(key, path)}:${serialize(item, `${path}.${key}`)}`);
  return `{${members.join(",")}}`;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "object":
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value, path);
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not JSON`);
  }
}

/** RFC 8785 canonical form. Accepts `unknown` so it can reject what the type system cannot. */
export function canonicalJson(value: unknown): CanonicalJson {
  const text = serialize(value, "$");
  return text as CanonicalJson; // branded here, at the only place the canonical form is produced
}
