---
section: Added
issue: 1402
---

**`mcpHttpListener` bounds its sessions** (#1402): sessions were kept until the client closed them, with no cap
and no expiry, so a loop of `initialize` requests, or clients that crash without a `DELETE`, grew memory without
end. New options with safe defaults: `sessionIdleTimeout` (30 minutes with no request or open stream),
`maxSessionsPerCaller` (100; over it `429`, `mcp.too-many-sessions`) and `maxSessions` (10 000; over it `503`,
`mcp.sessions-exhausted`). A refused request opens nothing.
