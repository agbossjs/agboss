---
section: Breaking
issue: 1317
---

**A call goes out with an HMAC, and no store or gateway sees a business key** (#1317, part d) —
`call.idempotencyKey` (and `lookup.idempotencyKey`) is 43 characters of base64url, an HMAC-SHA256 of the
call's tenant, name and business key (or step) under `@DatabaseStorage({ idempotencySecret })`. It is
minted when the intent is recorded and read back from it on every retry, reconciliation and replay, so
rotating the secret mid-flight never changes what the other system knows the call by.
`call.shortKey(length)` (16 to 43, else `IdempotencyError.InvalidKey`) is its prefix, for a gateway with a
short limit. A store keeps a business key as its HMAC under the idempotency secret (`EffectKeyFields.businessKey`
is the digest for `Idempotency`; `previousBusinessKey` is the one under `previousIdempotencySecret`, by which a row
written before a rotation is found). Keep the previous secret for the longest `ttl`: once it is removed, a
row written under it is not found and its call is made again.

- `sendOnce` always needs the secret (a call with no business key too): a component that reaches `A2AClient`
  or `Idempotency` with no `idempotencySecret` is refused at assembly.
- **Removed:** the readable key `<tenant>:<key>:<name>` and the handle form `business-key:<handle>:<name>`
  of reads, outcomes and errors — they carry the HMAC.
