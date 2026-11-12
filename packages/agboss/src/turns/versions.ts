import { createHash } from "node:crypto";

/** A value that has no canonical JSON form (`NaN`, `Map`, `Date`, a lone surrogate, …), with its path. */
export class NonJsonValueError extends Error {
  readonly path: string;
  readonly reason: string;

  // Plain fields, no parameter properties: the module stays loadable by Node's type stripping.
  constructor(path: string, reason: string) {
    super(`not JSON at ${path}: ${reason}`);
    this.name = "NonJsonValueError";
    this.path = path;
    this.reason = reason;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const childPath = (path: string, key: string): string =>
  IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

/** UTF-16 code-unit order (RFC 8785 §3.2.3) — never the locale. Keys of one object never tie. */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : 1);

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function canonicalString(text: string, path: string): string {
  if (LONE_SURROGATE.test(text)) throw new NonJsonValueError(path, "lone surrogate in a string");
  return JSON.stringify(text);
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new NonJsonValueError(path, String(value));
  // ECMAScript Number.prototype.toString is the RFC 8785 number form; -0 serialises as 0.
  return JSON.stringify(value);
}

function canonicalArray(items: readonly unknown[], path: string, seen: Set<object>): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const itemPath = `${path}[${String(i)}]`;
    const item: unknown = items[i];
    if (item === undefined) throw new NonJsonValueError(itemPath, "undefined in an array");
    parts.push(canonical(item, itemPath, seen));
  }
  return `[${parts.join(",")}]`;
}

function canonicalObject(value: object, path: string, seen: Set<object>): string {
  const parts = Object.keys(value)
    .sort(byCodeUnits)
    .flatMap((key) => {
      const item: unknown = Reflect.get(value, key);
      if (item === undefined) return [];
      const itemPath = childPath(path, key);
      return [`${canonicalString(key, itemPath)}:${canonical(item, itemPath, seen)}`];
    });
  return `{${parts.join(",")}}`;
}

function canonicalContainer(value: object, path: string, seen: Set<object>): string {
  if (seen.has(value)) throw new NonJsonValueError(path, "circular reference");
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new NonJsonValueError(path, `${value.constructor.name} is not a plain object`);
  }
  seen.add(value);
  try {
    return Array.isArray(value)
      ? canonicalArray(value, path, seen)
      : canonicalObject(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

function canonical(value: unknown, path: string, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
      return canonicalString(value, path);
    case "number":
      return canonicalNumber(value, path);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      return value === null ? "null" : canonicalContainer(value, path, seen);
    default:
      throw new NonJsonValueError(path, `${typeof value} is not JSON`);
  }
}

/**
 * Canonical JSON (RFC 8785, JCS): keys in UTF-16 code-unit order, ECMAScript number form,
 * undefined object properties left out — the same value serialises byte-identically everywhere.
 * Throws {@link NonJsonValueError} on anything that is not JSON, naming its path (`$.a[2]`).
 */
export const stableJson = (value: unknown): string => canonical(value, "$", new Set());

/** Content hash: SHA-256 of the canonical JSON, 64 hex characters. Equal inputs → equal versions. */
export const versionOf = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

/** Characters of a version shown to people. */
export const SHORT_VERSION_LENGTH = 8;

/** The printed form of a version: its first 8 characters. */
export const shortVersion = (version: string): string => version.slice(0, SHORT_VERSION_LENGTH);
