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
  // the prototype's own mark, never a `constructor` the value itself could shadow
  return Object.getOwnPropertyDescriptor(proto, DTO_PROTOTYPE)?.value === true;
}

/** `copy` with the prototype of `original` (a hydrated DTO stays a DTO when a walk rebuilds it). */
export function likeOriginal<T extends object>(original: object, copy: T): T {
  const proto: unknown = Object.getPrototypeOf(original);
  if (proto !== Object.prototype && proto !== null) Object.setPrototypeOf(copy, proto as object);
  return copy;
}
