---
section: Breaking
issue: 1320
---

**An MCP session admits each message by its own verified identity** (#1320): `McpService.handleMessage`
no longer compares the session with itself. Every POSTed message is admitted on its own; a session a peer
opened takes only that peer's signed messages (the identity is the verified decision's, never the echoed
input), and every session takes only its own caller's (`handleMessage(req, res, sessionId, body, caller)`:
the host's authenticator's identity for this request) — another caller with the session id is told there is
no such session. `createMcpService(app, config, { publicUrl })`: under a `@Mesh` an HTTP session needs the
public URL; a peer's signature must name its origin (`[mcp.public-url-required]`, `[mcp.public-url-invalid]`).
