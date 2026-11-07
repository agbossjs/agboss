import { issuedKey } from "../../infrastructure/issued-keys.js";
import type { EffectKey, EffectKeyFields } from "../../infrastructure/fenced-effect.repository.js";

/**
 * An `EffectKey` from its fields (#825), for a store's own tests and the contract suites: `fields`,
 * with `changes` over them (`effectKeyForTesting(key, { token: 2 })`). An application's step makes its
 * keys with `effectKeyOf(executionContext, name, …)` only: neither an object literal nor a spread copy
 * of a key compiles as one (its mark is a private member, which a spread drops), and at run time the
 * stores' entry and `OutboundCalls.send` take only the keys the framework made — `effectKeyOf`'s and
 * this function's. The store still checks every key at its entry (its name, its business key, its
 * scope and token, and under a business key a fingerprint or `FingerprintPolicy.None`).
 */
export const effectKeyForTesting = (
  fields: EffectKeyFields,
  changes: Partial<EffectKeyFields> = {},
): EffectKey => issuedKey({ ...fields, ...changes }) as EffectKey;
