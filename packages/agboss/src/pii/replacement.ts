import type { PiiPartOptions } from "./actions.js";

/** What hides a part of a value. */
const HIDDEN = "••••";
/** What hides the local part of an email that keeps its domain (`d•••@acme.com`). */
const HIDDEN_LOCAL = "•••";

/** `<israeli-id>`: a value replaced by its kind. */
export const kindPlaceholder = (label: string): string => `<${label}>`;

/** The characters that count for `keepFirst` / `keepLast`: separators of numbers are not kept. */
const significant = (value: string): string => value.replace(/[\s().-]/g, "");

function keptEmail(value: string): string | undefined {
  const at = value.lastIndexOf("@");
  if (at <= 0) return undefined;
  return `${value.slice(0, 1)}${HIDDEN_LOCAL}${value.slice(at)}`;
}

function kept(value: string, keepFirst: number, keepLast: number): string {
  const chars = significant(value);
  if (keepFirst + keepLast >= chars.length) return HIDDEN;
  const first = chars.slice(0, keepFirst);
  const last = keepLast === 0 ? "" : chars.slice(chars.length - keepLast);
  return [first === "" ? HIDDEN : `${first}${HIDDEN}`, last]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * `replacePart(…)`: `{ keepLast: 4 }` → `•••• 4242`, `{ keepDomain: true }` → `d•••@acme.com`,
 * `{ pattern }` → every match hidden. One-way: never stored, never revealed.
 */
export function partReplaced(value: string, part: PiiPartOptions): string {
  if (part.pattern !== undefined) {
    const flags = part.pattern.flags.includes("g") ? part.pattern.flags : `${part.pattern.flags}g`;
    return value.replace(new RegExp(part.pattern.source, flags), HIDDEN);
  }
  if (part.keepDomain === true) {
    const email = keptEmail(value);
    if (email !== undefined) return email;
  }
  return kept(value, part.keepFirst ?? 0, part.keepLast ?? 0);
}
