---
section: Breaking
issue: 1319
---

**MCP and A2A listeners per the spec** (#1319, #1320): an application with no `tenantContext` of its own needs no `authenticator` on `mcpHttpListener` / `a2aHttpListener` — its callers are anonymous, an MCP session of one bound to its connection; an authenticated tenant with no `ownerId` binds its session to the whole tenant identity (no `403 mcp.caller-anonymous` for it); a `tenantContext` without an `authenticator` fails the listener's creation with `ConfigError` (`[http.authenticator-required-for-tenant-context]`), not `ComponentError`. `McpSessionOptions.peer` is removed from the public type (only a verified signature names a peer); `BearerAuth` is `HeaderSecretTemplate`; `mcpHttpListener` and `connectMcp*` take `App<TApp>`.
