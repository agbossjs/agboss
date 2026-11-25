---
section: Breaking
issue: 1317
---

**Idempotency rows expire by their call's `ttl`** (#1317, part b) — `retention.fencedEffects` and
`retention.outboundCalls` are removed from `@Application({ retention })` (a field it does not know is
`[application.retention-invalid]`): every `runOnce` / `sendOnce` names its own `ttl`, kept as the row's
`expires_at` (`NULL` = `Ttl.Forever`, never removed). A scope's mark keeps the latest expiry written
under it, `NULL` first, so a short ttl never truncates a long one.

- **Stores:** `FencedEffectRepository.deleteByStoredAtBefore` and `OutboundCallRepository.deleteByEndedAtBefore`
  are `deleteExpired(now): Promise<number>`; `EffectKeyFields.expiresAt: Date | null`;
  `markCompleted` / `markFailed` take `expiresAt: Date | null` as a last argument;
  `findAllByTenantIdAndStatus` takes `PageQuery` (`cursor`, `limit?`) and returns `Page<OutboundCallRecord>`.
  A pending intent has no expiry. `parsedStoredJson` takes `{ what, text, ids?, reviver? }`.
- **Assembly:** an application with no `@DatabaseStorage` whose components reach `Idempotency` is refused at
  assembly (`[application.idempotency-key-required]`), not at its first keyed call; a test's assembly
  (`testWith`, unit runners, fault pods) gets the test's keys.
- **Removed:** `FencedEffectSettings`, `OutboundCallSettings` (the only thing left of them, whether a request
  is stored only masked, is the internal `OutboundMasking`), `DEFAULT_FENCED_EFFECT_RETENTION`,
  `DEFAULT_OUTBOUND_CALL_RETENTION`.
