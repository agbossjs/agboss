---
section: Breaking
issue: 1320
---

**`@A2AAgent` and `A2AClient`: references, `costPerCall`, one signal** (#1320): `@A2AAgent({ url,
headers?, timeout?, costPerCall?, allowedOrigins? })` takes `url` and `allowedOrigins` as a text or a
`defineEnv` reference and `headers` as texts, references, secrets or `bearer(secret)`, all read once from
the application's environment (a missing variable is named, never a value; a client built outside an
application reads the process's). `price` is now `costPerCall` (also on `A2AClientContract`), charged to
the calling step once per call, under the call's ledger identity, even when the call fails after the
accept; `[a2a.price-invalid]` is `[a2a.cost-per-call-invalid]`. `timeout` is how long a call waits for the
task unless the call says. `getHeaders()` may return a record or a promise, and declared headers, the
`headers` option and `getHeaders()` merge without regard to case, the last winning; `X-AGBoss-Mesh` is
never a client's. A call without a `signal` ends with the running step's, as an MCP server's call does.
