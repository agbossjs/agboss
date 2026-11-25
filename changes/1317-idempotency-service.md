---
section: Breaking
issue: 1317
---

**`Idempotency` replaces `FencedEffects` and `OutboundCalls`** (#1317, part a) — one service a component
injects (`deps: [Idempotency]`) with two async methods and named options, reading the execution from
the step, so no `ExecutionContext` is threaded through and no `effectKeyOf` is called:

- `idempotency.runOnce({ name, key?, fingerprint? | withoutFingerprint: true, ttl, timeout?, maxResultSize?, execute })`
  — a write of the application's own database, once per key, in the store's transaction with its
  result. `ttl` is required (above the lease's 30 s, or `Ttl.Forever`); `timeout` defaults to
  `seconds(15)` and must stay below the lease, a stalled `execute` rolls back.
- `idempotency.sendOnce({ name, key?, target, operation?, request, timeout, ttl, send, recovery, isDefiniteFailure?, maxPayloadSize? })`
  — a call that leaves the system; `timeout` (per attempt, required) bounds `call.signal`.
- `OutboundRecovery.replayWithin(keyTtl)`, `.permanentLookup(reconcile)`, `.lookupWithin(keyTtl, reconcile)`
  and `Reconciliation.completed(result)`, `.notExecuted()`, `.unknown(reason)` replace `notSent`,
  `NotSentTrust` and `OutboundCallReconciliation`. A recovery window must be above the call's `timeout`
  and at most its `ttl` (`OutboundCallError.InvalidRecovery`).
- Bad options reject (never throw synchronously): `ConfigError.Option` for a `ttl` or `timeout`.

The business-key HMAC secrets are `@DatabaseStorage({ idempotencySecret, previousIdempotencySecret })`.
`@Application({ idempotencyKeyField, previousIdempotencyKeyField, fencedEffects, outboundCalls })` are
removed: the largest result, the largest payload and the attempt bound are options of each call.

- **Errors** are family variants: `IdempotencyError.KeyConflict`, `.InvalidKey`, `.InvalidName`,
  `.FingerprintRequired`, `.FingerprintNotJson`, `.SecretKeyMissing`, `.ResultTooLarge`, `.StoreMismatch`
  and `OutboundCallError.InFlight`, `.Superseded`, `.Unreconciled`, `.ResultNotStored`, `.PayloadTooLarge`,
  `.Unmasked`, `.InvalidRecovery`. They are not `StepFailedError`s any more.
- **Observers and the audit log:** `onFencedEffect` / `FencedEffectEvent` are `onIdempotencyRun` /
  `IdempotencyRunEvent`; the audit kind `"fenced-effect"` is `"idempotency-run"`
  (`ExecutionAuditEventKind.IdempotencyRun`, `IdempotencyRunRecord`, `IdempotencyRunEventOutcome`);
  `FencedEffectStatus` / `FencedEffectOutcome` are `IdempotencyRunStatus` / `IdempotencyRunOutcome`.
- **`@agboss/core/stores`** now holds `effectKeyOf`, `EffectKey`, `EffectKeyFields`, `OutboundCallKey` and
  `ExecutionFence`; the root no longer exports them. `FingerprintPolicy.None` is `withoutFingerprint: true`.
  The fenced-effect repositories take no settings.
- **Removed:** `FencedEffects`, `OutboundCalls`, `NotSentTrust`, `OutboundCallReconciliation`,
  `OutboundCallVerdict`, `FingerprintPolicy`, `FencedEffectSettings`, `OutboundCallSettings`,
  `FencedEffectOptions`, `OutboundCallOptions`, `FingerprintKeys` (root), the old error classes
  (`BusinessKeyConflictError`, `InvalidBusinessKeyError`, `InvalidFencedEffectNameError`,
  `FingerprintNotJsonError`, `FingerprintRequiredError`, `IdempotencyKeyMissingError`,
  `FencedEffectResultTooLargeError`, `FencedEffectStoreMismatchError`, `OutboundCall*Error`,
  `InvalidNotSentTrustError`), the rules `application.fenced-effects-invalid`,
  `application.outbound-calls-invalid` and `application.idempotency-key-shared`.

Store follow-up: `FencedEffectRepository` loses its `settings` constructor argument; the largest result is
`EffectKeyFields.maxResultSize`; `fingerprintPolicy` is `withoutFingerprint`; the audit kind is `idempotency-run`.
