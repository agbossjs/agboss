import { ConfigError } from "../core/error-families/config-errors.js";
import type { ExecutionContext } from "../flow/context/execution-context.js";
import { businessKeyDigestsOf } from "../infrastructure/business-key-digest.js";
import {
  assertBusinessKey,
  businessKeyHashOf,
  effectKeyOf,
} from "../infrastructure/fenced-effect-key.js";
import type { EffectKey, EffectKeyFields } from "../infrastructure/fenced-effect.repository.js";
import { issuedKey } from "../infrastructure/issued-keys.js";
import type { Bytes } from "../units/index.js";

/**
 * The key of an `Idempotency` call (#1317d): the step's, or — under a business key — the tenant's
 * digest of it (`businessKeyDigestsOf`: an HMAC under the application's idempotency secret, and
 * under the previous one during a rotation). No store, no record and no gateway sees the key itself.
 */

/** The key's handle (#508), from its text and not its digest: none where no PII key is at hand. */
function handleOf(key: string): { readonly businessKeyHash?: string } {
  const businessKeyHash = businessKeyHashOf(key);
  return businessKeyHash === undefined ? {} : { businessKeyHash };
}

/** What a call's key is made of besides the step: its business key and what the effect does. */
export interface CallKeyParts {
  readonly key?: string | undefined;
  readonly fingerprint?: unknown;
  readonly withoutFingerprint?: unknown;
  /** When its rows may be removed (`null`: never). */
  readonly expiresAt: Date | null;
  readonly maxResultSize?: Bytes | undefined;
}

/**
 * The key of the current step's effect `name`: its business key as its digest (the key's text is
 * checked first: `IdempotencyError.InvalidKey`), the fingerprint it says, and its expiry.
 */
export function callKeyIn(
  context: ExecutionContext,
  name: string,
  parts: CallKeyParts,
  method: "runOnce" | "sendOnce",
): EffectKey {
  const { key, fingerprint, withoutFingerprint, expiresAt, maxResultSize } = parts;
  if (key === undefined) {
    if (fingerprint !== undefined || withoutFingerprint !== undefined)
      throw new ConfigError.Option({
        message: `Idempotency.${method}: a fingerprint needs a key: it says what the work under it does — nothing was recorded, run or sent`,
      });
    return issuedKey({
      ...(effectKeyOf(context, name) as EffectKeyFields),
      expiresAt,
    }) as EffectKey;
  }
  assertBusinessKey({ name, businessKey: key });
  const digests = businessKeyDigestsOf(name, key);
  const made = effectKeyOf(context, name, {
    businessKey: digests.businessKey,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(withoutFingerprint === undefined ? {} : { withoutFingerprint }),
  } as Parameters<typeof effectKeyOf>[2]);
  return issuedKey({
    ...(made as EffectKeyFields),
    // the handle an error shows is of the key's text: the caller matches it with their own log
    ...handleOf(key),
    expiresAt,
    ...(digests.previousBusinessKey === undefined
      ? {}
      : { previousBusinessKey: digests.previousBusinessKey }),
    ...(maxResultSize === undefined ? {} : { maxResultSize }),
  }) as EffectKey;
}
