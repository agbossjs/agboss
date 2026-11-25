/**
 * Source text the OpenAPI generator writes, already in the shape prettier gives it (printWidth 100),
 * so a generated project passes `prettier --check` without a formatter installed.
 */
const WIDTH = 100;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A sample value of a DTO field: what the generated tests send and answer. */
export type Sample = string | number | boolean | Sample[] | { [key: string]: Sample };

/** Prose from the spec as one double-quoted string literal (no line breaks, no double quotes). */
export const text = (raw: string): string =>
  JSON.stringify(raw.replace(/\s+/g, " ").replace(/"/g, "'").trim());

/** Prose from the spec for a `/** … *\/` comment. */
export const comment = (raw: string): string =>
  raw.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();

/** An object key or class field name, quoted only when it is not an identifier. */
export const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

/** `object.name`, or `object["na-me"]` for a name that is not an identifier. */
export const access = (object: string, name: string): string =>
  IDENTIFIER.test(name) ? `${object}.${name}` : `${object}[${JSON.stringify(name)}]`;

/** `key: value,` — a string too long for the line moves under its key. */
export function entry(indent: number, key: string, value: string): string {
  const pad = " ".repeat(indent);
  const line = `${pad}${key}: ${value},`;
  return line.length <= WIDTH || !value.startsWith('"') ? line : `${pad}${key}:\n${pad}  ${value},`;
}

/** `head(lead, { key: value })` on one line when it fits, else with the options object expanded. */
export function call(
  indent: number,
  head: string,
  lead: readonly string[],
  options: readonly (readonly [string, string])[],
): string {
  const pad = " ".repeat(indent);
  const object = options.map(([key, value]) => `${key}: ${value}`).join(", ");
  const one = `${pad}${head}(${[...lead, `{ ${object} }`].join(", ")})`;
  if (one.length <= WIDTH) return one;
  return [
    `${pad}${head}(${[...lead, "{"].join(", ")}`,
    ...options.map(([key, value]) => entry(indent + 2, key, value)),
    `${pad}})`,
  ].join("\n");
}

/** `import { a, b } from "from";`, one name per line when it does not fit. */
export function importLine(names: readonly string[], from: string, typeOnly = false): string {
  const keyword = typeOnly ? "import type" : "import";
  const one = `${keyword} { ${names.join(", ")} } from "${from}";`;
  return one.length <= WIDTH
    ? one
    : `${keyword} {\n${names.map((name) => `  ${name},`).join("\n")}\n} from "${from}";`;
}

/** `export class Name {`: a tool needs no `implements`, `@Tool` checks `execute` against its DTOs. */
export function classHeader(name: string): string {
  return `export class ${name} {`;
}

/** A sample as a literal: objects expanded (prettier keeps them so), lists empty. */
export function literal(value: Sample, indent: number): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return "[]";
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const lines = entries.map(
    ([key, item]) => `${pad}  ${propertyKey(key)}: ${literal(item, indent + 2)},`,
  );
  return `{\n${lines.join("\n")}\n${pad}}`;
}
