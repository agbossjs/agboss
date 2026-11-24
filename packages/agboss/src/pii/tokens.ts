import { createHmac, randomBytes } from "node:crypto";
import { PiiKeyPurpose, purposeDigestOf } from "./key-hierarchy.js";

/**
 * The tokens of `tokenize()` (#120 S38): `<email:7f3a91>` — the first hex digits of the
 * HMAC-SHA256 of the normalised value under the pseudonym key derived from the policy's
 * `pseudonymKey` (#1269: `PiiKeyPurpose.Pseudonym`, never the key itself), so one value is one token
 * everywhere. The token → value map is the execution's `piiTokens` channel (in its checkpoint);
 * only these tokens are revealed, `mask()` / `mask()` are one-way.
 */

/**
 * A new random key for field tokens: an instance's when the application sets no `piiKeyField`
 * (#120 S94), and each root execution's then (#334).
 */
export const newPiiKey = (): string => randomBytes(32).toString("hex");

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

/** The HMAC-SHA256 of `text` under `key`, in hex: a business key's handle and a fingerprint are made of it (never a token, #1269). */
export const keyedDigestOf = (key: string, text: string): string =>
  createHmac("sha256", key).update(text).digest("hex");

/**
 * The token of a value: the shortest prefix (6 hex digits and up, by two) that does not stand for another
 * value in `known` — one token per value within an execution; the whole digest (64 digits, reached from 6
 * by twos) when every shorter prefix is taken, even if it is too (an HMAC-SHA256 collision).
 */
export function tokenOf(label: string, value: string, key: string, known: PiiTokenMap): string {
  const digest = purposeDigestOf(key, PiiKeyPurpose.Pseudonym, normalisedValue(label, value));
  for (let length = SHORT; ; length += 2) {
    const token = `<${label}:${digest.slice(0, length)}>`;
    const taken = known[token];
    const isFree =
      taken === undefined || normalisedValue(label, taken) === normalisedValue(label, value);
    if (isFree || length === digest.length) return token;
  }
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
