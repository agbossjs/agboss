import { scopeKeyOf } from "../app/lease-lost.js";
import type { EffectKey, EffectKeyFields } from "./effect-key.js";

/**
 * The keys this process made (#825): `effectKeyOf`, a call's key with its request's fingerprint, and
 * `effectKeyForTesting` — what `runOnce` and `OutboundCalls.send` take. The type's mark
 * keeps a forged key (`{ ...key, token: key.token + 1 }`) from compiling; this keeps one from a
 * JavaScript caller or a cast from running.
 */
const issued = new WeakSet<object>();

/** `key`, frozen and recorded as made by the framework. */
export function issuedKey<TKey extends object>(key: TKey): TKey {
  issued.add(Object.freeze(key));
  return key;
}

/** Whether `key` is one the framework made (never a copy of one; a primitive never is). */
export const isIssuedKey = (key: unknown): boolean => issued.has(key as object);

/** A key made by hand that is not one of a lease scope. */
export class InvalidFencedEffectKeyError extends TypeError {
  override name = "InvalidFencedEffectKeyError";
}

/** Why a key made by hand is refused (#825). */
export const UNISSUED_KEY =
  "not a fenced effect key: make it with effectKeyOf(executionContext, name, …) — a copy or an object built by hand is no key (effectKeyForTesting in a store's tests)";

/** Why a key cannot be one: its scope does not match its parts, no name, no token. */
export function keyProblemOf(key: EffectKey): string | undefined {
  if (key.scopeKey !== scopeKeyOf(key.tenantId, key.leaseExecutionId))
    return `its scopeKey ${JSON.stringify(key.scopeKey)} is not the scope of tenant ${key.tenantId} and execution ${key.leaseExecutionId}`;
  if (!Number.isInteger(key.token) || key.token < 1)
    return `its token ${String(key.token)} is not a lease epoch (a whole number from 1)`;
  if (key.idempotencyKey.length === 0) return "its idempotencyKey must not be empty";
  return undefined;
}

/**
 * The tree a key's cancel fences (#909, exported for stores outside the core): its root in its
 * tenant — `rootExecutionId`, set by `effectKeyOf`, else the key's own lease execution.
 */
export const cancelTreeOf = (
  key: Pick<EffectKeyFields, "tenantId" | "leaseExecutionId" | "rootExecutionId">,
): { readonly tenantId: string; readonly rootExecutionId: string } => ({
  tenantId: key.tenantId,
  rootExecutionId: key.rootExecutionId ?? key.leaseExecutionId,
});
