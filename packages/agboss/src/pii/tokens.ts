import { createHmac } from "node:crypto";

/**
 * The tokens of `replaceWithToken()` (#120 S38): `<email:7f3a91>` — the first hex digits of the
 * HMAC-SHA256 of the normalised value with the policy's `pseudonymKey`, so one value is one token
 * everywhere. The token → value map is the execution's `piiTokens` channel (in its checkpoint);
 * only these tokens are revealed, `replaceWithKind()` / `replacePart()` are one-way.
 */

/** Token → the value it stands for (the `piiTokens` channel). */
export type PiiTokenMap = Readonly<Record<string, string>>;

/** A token in text: `<label:hex>`. */
const TOKEN = /<([a-z][a-z0-9-]*):([0-9a-f]{6,64})>/g;

const SHORT = 6;

/** The value as hashed: NFC, trimmed; emails lower-cased; numbers without separators. */
export function normalisedValue(label: string, value: string): string {
  const text = value.normalize("NFC").trim();
  if (label === "email") return text.toLowerCase();
  if (/^[+\d\s().-]+$/.test(text)) return text.replace(/[\s().-]/g, "");
  return text.replace(/\s+/g, " ");
}

/**
 * The token of a value: the shortest prefix (6 hex digits and up) that does not stand for another
 * value in `known` — one token per value within an execution.
 */
export function tokenOf(label: string, value: string, key: string, known: PiiTokenMap): string {
  const digest = createHmac("sha256", key).update(normalisedValue(label, value)).digest("hex");
  for (let length = SHORT; length < digest.length; length += 2) {
    const token = `<${label}:${digest.slice(0, length)}>`;
    const taken = known[token];
    if (taken === undefined || normalisedValue(label, taken) === normalisedValue(label, value))
      return token;
  }
  return `<${label}:${digest}>`;
}

/** Text with its known tokens replaced by their values, and the tokens it has that the map does not know. */
export interface RevealedText {
  readonly text: string;
  readonly unknownTokens: readonly string[];
}

/** Replaces every known token by its value; unknown ones stay and are listed. */
export function revealedText(text: string, tokens: PiiTokenMap): RevealedText {
  const unknownTokens: string[] = [];
  const revealed = text.replace(TOKEN, (token) => {
    const value = tokens[token];
    if (value !== undefined) return value;
    unknownTokens.push(token);
    return token;
  });
  return { text: revealed, unknownTokens };
}

/** The `piiTokens` reducer: tokens are deterministic, so maps merge by key (branches, children). */
export const mergeTokens = (left: PiiTokenMap, right: PiiTokenMap): Record<string, string> => ({
  ...left,
  ...right,
});
