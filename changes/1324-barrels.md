---
section: Breaking
issue: 1324
---

**Five deprecated entries, the `Tern*` aliases and the test channels leave the root** (#1324d). The
entries `@agboss/core/core`, `/graph`, `/router`, `/tool` and `/channels` are removed
(`package.json#exports` and `deprecatedExports` is empty), with their API reports; import from
`@agboss/core`. The deprecated `Tern`, `NewTern`, `TernOutcome`, `TernStatus` and `TernStep` aliases
are removed: use `Turn*`. `AutoApproveChannel` and `AutoRejectChannel` move from `@agboss/core` to
`@agboss/core/testing`. `COMPONENT_DECORATORS` (the `agboss/no-component-state` list) also holds
`Application`, `Workflow`, `WorkflowStart`, `WorkflowFinish`, `Agent`, `Mesh`, `McpEndpoint`,
`A2AEndpoint` and `EvalSuite`.
