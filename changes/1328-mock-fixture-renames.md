---
section: Breaking
issue: 1328
---

**The mock fixtures are named alike: `mockModel`, `mockService`, `mockMcp`; `.respondWith` and `.reset()`** (#1328, part a): the `testWith` fixtures `mockLlm`, `mockOf` and `mcpOf` are `mockModel`, `mockService` and `mockMcp` (as on `testModule` and `testAgent`), and `ModelScript.thenAnswer(handler)` is `respondWith(handler)`. `ModelScript`, `ToolScript`, `ActionScript` and `McpStub` got `reset()` (as `mockRag` and `mockA2A` have): it forgets what was scripted and what was called. `mcpServerStub` is removed: stub an MCP server with `mockMcp(Server).thenReturn({ … })`.
