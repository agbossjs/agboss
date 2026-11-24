---
section: Breaking
issue: 1319
---

**MCP and A2A listeners: anonymous access is opt-in and token-bound, never socket-bound** (#1316, #1319, #1320):
`mcpHttpListener` and `a2aHttpListener` take `allowAnonymous?: boolean` (default `false`). An `@HttpAuthenticator` is
required unless `allowAnonymous: true` is set (only in an application with no `tenantContext` of its own, and not
beside an authenticator) or only signed peers call (`@Mesh({ inboundMode: Strict })` with a peer that propagates its
tenant); a forgotten one, or `allowAnonymous` with a `tenantContext`, fails the listener's creation with `ConfigError`
(`[http.authenticator-required-for-tenant-context]`). Nothing is bound to a TCP connection any more: an anonymous
MCP caller is `anonymous:<Mcp-Session-Id>`, an authenticated tenant with no `ownerId` is `mcp-session:<Mcp-Session-Id>`
inside its tenant; in A2A a caller that names no owner gets an owner of its own for each new task, the task's id is
the right to get, continue and cancel it, and `ListTasks` is `403 a2a.list-forbidden`. An authenticator that names an
owner beginning `anonymous:`, `mcp-session:` or `a2a-task:` is refused. `McpSessionOptions.peer` is removed from the
public type (only a verified signature names a peer); `BearerAuth` is `HeaderSecretTemplate`; `mcpHttpListener` and
`connectMcp*` take `App<TApp>`.
