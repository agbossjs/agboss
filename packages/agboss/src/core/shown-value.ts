/** The name of an object's class, `undefined` for a plain object. */
function classNameOf(value: object): string | undefined {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  const name = prototype?.constructor?.name;
  return name === undefined || name === "Object" || name === "" ? undefined : name;
}

/**
 * A value a caller gave, as an error message shows it (#834): a string quoted, an object by its
 * kind (`a Map`, `an object`), never `[object Object]` — and never its contents.
 */
export function shownValueOf(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "function") return "a function";
  if (typeof value !== "object" || value === null) return String(value);
  if (Array.isArray(value)) return "an array";
  const name = classNameOf(value);
  return name === undefined ? "an object" : `a ${name}`;
}
