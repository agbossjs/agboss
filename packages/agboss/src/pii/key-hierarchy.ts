import { createHmac, hkdfSync } from "node:crypto";

/**
 * The PII key hierarchy (#1269). One root, the application's PII key (`@Application({ piiKeyField })`,
 * `PII_PSEUDONYM_KEY`; a key of the instance when none is set, S94; a policy's own `pseudonymKey` for
 * its tokens), and below it one key per purpose: HKDF-SHA256 of the root under the purpose's own label.
 * No two purposes share a key, so one input never gives the same digest in two places (a token is never
 * a cache key, a cache key never a policy's hash), and no digest of one purpose tells anything of another.
 *
 * A purpose key is derived when it is used and never kept: not in a checkpoint, not in a cache, not in
 * a store. The one key an execution keeps is its own token key (#334, only without `piiKeyField`): it is
 * the root of its pseudonyms alone, whose values its checkpoint holds anyway (`piiTokens`); every digest
 * kept beside it — a cached transcription's or redacted copy's key, a masked text's key, the policies'
 * hash — is under a purpose key of the application's (or the instance's) root, which no store holds.
 */

/** The purposes, each the HKDF `info` its key is derived under. A label is never reused: a new scheme is a new label. */
export enum PiiKeyPurpose {
  /** `tokenize()` tokens and `sensitive` fields' tokens: `<label:hex>`. */
  Pseudonym = "agboss/pii/pseudonym/v2",
  /** What a policy set masks with (`PiiPolicySet.fingerprint`): a cached transcription's key. */
  PolicyHash = "agboss/pii/policy-hash/v2",
  /** What a redactor is asked to hide, and the values it is told: a cached redacted copy's key. */
  FileCache = "agboss/files/cache-key/v2",
  /** A text an agent's loop has masked already (its `piiMasked` channel). */
  MaskCache = "agboss/pii/mask-cache/v2",
  /** Which token key a policy set makes tokens with, inside its hash (never shown). */
  KeyId = "agboss/pii/key-id/v2",
}

/** The HKDF salt: fixed, the hierarchy's own name (RFC 5869 §3.1 — a salt is optional; a fixed one separates it from other uses of the root). */
const SALT = "agboss/pii-key-hierarchy";

const KEY_BYTES = 32;

/** The key of one purpose under `root`: HKDF-SHA256, 32 bytes. Derived on every use, never kept. */
export const purposeKeyOf = (root: string, purpose: PiiKeyPurpose): Buffer =>
  Buffer.from(hkdfSync("sha256", root, SALT, purpose, KEY_BYTES));

/** The HMAC-SHA256 of `text` under the key of `purpose` below `root`, in hex. */
export const purposeDigestOf = (root: string, purpose: PiiKeyPurpose, text: string): string =>
  createHmac("sha256", purposeKeyOf(root, purpose)).update(text).digest("hex");
