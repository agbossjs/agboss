---
section: Breaking
issue: 1319
---

**`@McpEndpoint` and the MCP transports** (#1319): `@McpExpose` is `@McpEndpoint({ name, version, description?, tools })`
(`exports` is `tools`). `McpService`, `createMcpService`, `McpSession`, `McpServiceOptions`, `handleSse`
and `handleMessage` are removed: serve over stdio with `connectMcpStdio(app, { endpoint, session? })`, over
any SDK server transport with `connectMcp(app, { endpoint, transport, session? })` (both return an
`McpConnection`, `await using` closes it; the transport is typed by AGBoss's own structural
`McpWireTransport`, and an application with a `tenantContext` must pass a `session` with its tenant), and over
Streamable HTTP with `mcpHttpListener(app, { endpoint, publicUrl, authenticator?, base?, maxBodySize?, onError? })`.
Each HTTP request is admitted on its own — a signed mesh peer (`X-AGBoss-Mesh`, for `publicUrl`'s origin) or the
`@HttpAuthenticator`'s caller (`[http.authenticator-required-for-tenant-context]` without one, unless the `@Mesh`
is `Strict` with a tenant-propagating peer) — and an MCP session belongs to the identity that opened it. A `Strict`
`@Mesh` serves no endpoint `@Application({ exposes })` does not list (`[application.expose-unlisted]`).
