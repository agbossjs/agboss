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
