---
section: Changed
issue: 1324
---

**`[storage.secret-shared]` covers the whole application** (#1324, B1b) — the variable of a `@DatabaseStorage`'s `piiSecret`, `previousPiiSecret`, `idempotencySecret` or `previousIdempotencySecret` may not be read by anything else the application holds: a model provider's `apiKey`, the `@Mesh` `signingKey`, a PII policy's key or any other `secret(…)` / `env(…)` of a component, driver or `deps: [appEnv]`. Rotating a provider's or the mesh's key never changes every stored token or fingerprint. Two model providers on one key are fine. The fault suite's `FaultStorage` gains `cluster?: DriverSettings`: the pod then declares a `@ClusterStorage` with those settings, for a store set whose coordination stores (Redis) are on another backend than its database (SQLite).
