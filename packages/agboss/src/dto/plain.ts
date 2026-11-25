import { DTO_PROTOTYPE } from "./metadata.js";

/**
 * Whether a value is data the walks may go into: a plain object (`Object.prototype` or none) or a
 * hydrated DTO (its prototype's own `constructor` is a registered DTO class). `Date`, `Error`,
 * `RegExp`, typed arrays and other instances are neither: they pass through untouched. An own
 * `constructor` property on the value never counts (it could shadow the class).
 */
export function isDtoOrPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  // the mark on a prototype up the chain (a subclass of a DTO), never a `constructor` the value itself could shadow
  for (
    let at: unknown = proto;
    typeof at === "object" && at !== null;
    at = Object.getPrototypeOf(at)
  ) {
    if (Object.getOwnPropertyDescriptor(at, DTO_PROTOTYPE)?.value === true) return true;
  }
  return false;
}

/** Objects that are leaves, never records: they have no fields of a DTO to mask. */
const isLeaf = (value: object): boolean =>
  value instanceof Date ||
  value instanceof RegExp ||
  value instanceof Error ||
  value instanceof Map ||
  value instanceof Set ||
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer;

/**
 * Whether masking and hiding walks must go into a value: every non-array object except the known
 * leaves (`Date`, `RegExp`, typed arrays and `Buffer`, `Map`, `Set`, `Error`). Fail-closed: a class
 * instance, a null-prototype object or a DTO subclass is walked, never passed on unmasked.
 */
export function isWalkable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isLeaf(value);
}

/** `copy` with the prototype of `original` (a hydrated DTO stays a DTO when a walk rebuilds it). */
export function likeOriginal<T extends object>(original: object, copy: T): T {
  const proto: unknown = Object.getPrototypeOf(original);
  if (proto !== Object.prototype && proto !== null) Object.setPrototypeOf(copy, proto as object);
  return copy;
}
