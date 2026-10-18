/**
 * Every string inside a JSON-like value, mapped: plain objects and arrays rebuilt, anything else —
 * a class instance (an `Error`, a message), a number — kept as it is.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Each string of `value` through `map`, at once. */
export function mappedStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item: unknown) => mappedStrings(item, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mappedStrings(item, map)]),
  );
}

/** Each string of `value` through `map`, one after the other (a map may call a model). */
export async function mappedStringsAsync(
  value: unknown,
  map: (text: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value as readonly unknown[]) items.push(await mappedStringsAsync(item, map));
    return items;
  }
  if (!isRecord(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value))
    entries.push([key, await mappedStringsAsync(item, map)]);
  return Object.fromEntries(entries);
}

/** The record form of a mapped object (tool arguments stay an object). */
export const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? { ...value } : {};
