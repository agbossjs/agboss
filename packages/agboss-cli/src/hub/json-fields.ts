/**
 * Reading the fields of a JSON value the Hub was given (#401): a file is data from another team's
 * pipeline, so every field is checked before it is used — a missing or mistyped one is a reason,
 * never a crash.
 */

/** A JSON object's fields. */
export type JsonObject = Readonly<Record<string, unknown>>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field that is not what it should be: its path and what was expected. */
export class FieldError extends Error {
  override name = "FieldError";
}

/** `object.key` as an object. */
export function objectAt(object: JsonObject, key: string, path: string): JsonObject {
  const value = object[key];
  if (!isObject(value)) throw new FieldError(`${path}.${key} is not an object`);
  return value;
}

/** `object.key` as a string. */
export function textAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new FieldError(`${path}.${key} is not a string`);
  return value;
}

/** `object.key` as a string, or undefined when absent. */
export function optionalTextAt(object: JsonObject, key: string, path: string): string | undefined {
  return object[key] === undefined ? undefined : textAt(object, key, path);
}

/** `object.key` as a list. */
export function listAt(object: JsonObject, key: string, path: string): readonly unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new FieldError(`${path}.${key} is not a list`);
  return value;
}

/** `object.key` as a list of objects. */
export function objectsAt(object: JsonObject, key: string, path: string): readonly JsonObject[] {
  return listAt(object, key, path).map((item, index) => {
    if (!isObject(item)) throw new FieldError(`${path}.${key}[${String(index)}] is not an object`);
    return item;
  });
}
