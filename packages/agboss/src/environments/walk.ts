import { Secret } from "./secret.js";
import { VariableReference } from "./variables.js";

/**
 * The fields of an environment file, walked (#261): every value at its path (`databaseUrl`,
 * `limits.port`) — plain objects and arrays are walked into, anything else is a leaf.
 */

/** A value read from the process at start: an `env(…)` reference or a `secret(…)`. */
export type ProcessValue = VariableReference | Secret;

export const isProcessValue = (value: unknown): value is ProcessValue =>
  value instanceof VariableReference || value instanceof Secret;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The same shape with every leaf replaced by `leaf(value, path)`; objects and arrays frozen. */
export function mapLeaves(
  value: unknown,
  leaf: (value: unknown, path: string) => unknown,
  path = "",
): unknown {
  const at = (key: string): string => (path === "" ? key : `${path}.${key}`);
  if (Array.isArray(value))
    return Object.freeze(
      value.map((item: unknown, index) => mapLeaves(item, leaf, at(String(index)))),
    );
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      mapLeaves(item, leaf, at(key)),
    ]);
    return Object.freeze(Object.fromEntries(entries));
  }
  return leaf(value, path);
}

/** Every leaf with its path, in field order. */
export function leavesOf(value: unknown): readonly (readonly [string, unknown])[] {
  const found: (readonly [string, unknown])[] = [];
  mapLeaves(value, (item, path) => {
    found.push([path, item]);
    return item;
  });
  return found;
}
