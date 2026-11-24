import { createHmac } from "node:crypto";
import { currentFrame } from "../flow/context/frame.js";
import { secretKeyMissing } from "./idempotency-errors.js";
import type { EffectKeyFields } from "./effect-key.js";

/**
 * What the stores and the other system see of a business key (#1317d): never the key itself — a
 * 43-character base64url HMAC-SHA256 of it under the application's idempotency secret (a subkey
 * derived under a label of its own, so no digest is another's). A store keeps the digest as the row's
 * business key; a call's wire key is minted of it once and persisted (`callKeyOf`).
 */

/** The label the business key's digest is made under: `HMAC(secret, label)` is its subkey. */
export const BUSINESS_KEY_DIGEST_LABEL = "agboss/business-key-digest/v1";

/** The label a call's wire key is made under. */
export const CALL_KEY_LABEL = "agboss/call-key/v1";

/** The length of every digest: 32 bytes as base64url, no padding. */
export const DIGEST_LENGTH = 43;

/** `text` as a digest under a subkey of `secret` derived under `label`. */
const digestOf = (secret: string, label: string, text: string): string =>
  createHmac("sha256", createHmac("sha256", secret).update(label).digest())
    .update(text)
    .digest("base64url");

/** What a business key is, under one secret: its tenant, its effect's name and its text, unambiguously. */
const identityOf = (tenantId: string, name: string, businessKey: string): string =>
  [String(tenantId.length), tenantId, String(name.length), name, businessKey].join("\u0000");

/** The business key's digest under the current secret, and under the previous one during a rotation. */
export interface BusinessKeyDigests {
  readonly businessKey: string;
  readonly previousBusinessKey?: string;
}

/**
 * The digests of `businessKey` under idempotency secrets `keys` (the previous one only during a
 * rotation). The tenant and the effect's name are not in it: a store's row is found by them beside it.
 */
export function businessKeyDigestsUnder(
  keys: { readonly current: string; readonly previous?: string | undefined },
  businessKey: string,
): BusinessKeyDigests {
  const businessKeyDigest = digestOf(keys.current, BUSINESS_KEY_DIGEST_LABEL, businessKey);
  if (keys.previous === undefined) return { businessKey: businessKeyDigest };
  return {
    businessKey: businessKeyDigest,
    previousBusinessKey: digestOf(keys.previous, BUSINESS_KEY_DIGEST_LABEL, businessKey),
  };
}

/**
 * The digests of `businessKey` of effect `name`, under the idempotency secrets of the step's
 * execution (`IdempotencyError.SecretKeyMissing` where there are none: never an unkeyed digest).
 * The previous one is what a row written before a rotation is found by.
 */
export function businessKeyDigestsOf(name: string, businessKey: string): BusinessKeyDigests {
  const keys = currentFrame()?.execution.fingerprintKeys;
  if (keys === undefined) throw secretKeyMissing({ effect: name });
  return businessKeyDigestsUnder(keys, businessKey);
}

/**
 * The wire key a call is first sent with: of its business key's digest, or — a call with no key — of
 * its step's idempotency key; under the current secret. Minted once, when the intent is recorded:
 * every retry, reconciliation and replay reads it back from the intent, so a rotation never changes
 * what the other system knows the call by.
 */
export function callKeyDigestOf(key: CallKeyFields): string {
  const keys = currentFrame()?.execution.fingerprintKeys;
  if (keys === undefined) throw secretKeyMissing({ effect: key.name });
  return callKeyDigestUnder(keys.current, key);
}

/** What a call's wire key is made of: its tenant, name and business key (a digest) — or its step. */
export type CallKeyFields = Pick<
  EffectKeyFields,
  "tenantId" | "name" | "businessKey" | "idempotencyKey"
>;

/** `callKeyDigestOf` under the idempotency secret `secret`. */
export function callKeyDigestUnder(secret: string, key: CallKeyFields): string {
  const text =
    key.businessKey === undefined
      ? `step\u0000${identityOf(key.tenantId, key.name, key.idempotencyKey)}`
      : `business\u0000${identityOf(key.tenantId, key.name, key.businessKey)}`;
  return digestOf(secret, CALL_KEY_LABEL, text);
}

/** The prefix of `key` a gateway with a short limit takes (`16..43`), else `undefined`. */
export const shortKeyOf = (key: string, length: unknown): string | undefined =>
  typeof length === "number" && Number.isInteger(length) && length >= 16 && length <= DIGEST_LENGTH
    ? key.slice(0, length)
    : undefined;
