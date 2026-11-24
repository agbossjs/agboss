---
section: Breaking
issue: 1320
---

**`@Mesh` is a component; the mesh signs HTTP too** (#1320): `@Application({ mesh })` takes a
`@Mesh({ signingKey, inboundMode, deduplicationTtl, maxHops, envelopeTtl?, maxClockSkew?, peers })`
class. `maxMeshHops`, `retention.meshAnswers`, the field-name `signingKey` and a peer's `verifyKey`
are gone: keys are `defineEnv` references (`secret(…)`), a peer lists `verifyKeys` (any of them
verifies, for a rotation), `allowEndpoints` and `propagateTenant`. Every HTTP request of an
`A2AClient` and an `@McpServer` carries `X-AGBoss-Mesh` (EdDSA JWS over issuer, audience, origin,
method, path, body hash, dates, a one-time `jti` and the tenant), signed even for the handshakes
before any step runs; a receiver verifies the signature first, then audience, origin, the date window
(`maxClockSkew`, `envelopeTtl` as the cap), that it is this request, and admits each `jti` once
(shared `MeshRequestRepository`; unavailable → refused). Refusals are typed codes (`mesh.peer-unknown`,
`mesh.signature-missing`, `mesh.request-mismatch`, `mesh.replayed`, `mesh.replay-check-unavailable`,
`mesh.endpoint-forbidden`, `mesh.tenant-mismatch`), never a peer's text. A verified peer's tasks are
owned by `mesh:<peer>`. `a2aHttpListener({ authenticator })` is optional for a `Strict` mesh with a
`propagateTenant` peer on the base tenant context (`[http.authenticator-required-for-tenant-context]`
otherwise). New rules: `[mesh.not-a-mesh]`, `[mesh.limit-invalid]`, `[mesh.peer-without-keys]`,
`[mesh.unknown-endpoint]`. `McpService.handleSse(req, res, …)` takes the request: with a `@Mesh` every
HTTP request to an MCP endpoint goes through the same gate as an A2A one (an unsigned request to a
`Strict` endpoint, an endpoint outside `allowEndpoints`, a replay: refused), and a `Strict` mesh serves
no endpoint `@Application({ exposes })` does not list. The MCP client never follows a redirect with its
header to another origin. No migration: 0.1.0 has no users.
