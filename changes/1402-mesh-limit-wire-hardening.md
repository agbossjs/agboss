---
section: Security
issue: 1402
---

**A mesh limit read off the wire is a verified peer's word only, and never text of a remote** (#1402): any MCP
server or A2A agent could return a `limit.mesh-loop` / `limit.hops` body whose names (any characters, up to 200
each, 64 hops) became the message of a local error, then reached logs and was relayed to this application's own
callers. The shape is now read only from a peer the call was addressed and signed to (`target.application`, the
mesh echoed); any other server's is an ordinary `McpError.Unavailable` / `A2AError.TaskFailed`. Names are limited
to 128 printable characters of the name charset, and the error's message is fixed text: the peer's names stay in
`entry` and `callChain` (new `isRemote` on both errors). Migration: a limit from an unaddressed server is no
longer rebuilt as `MeshLoopDetectedError` / `HopsLimitExceededError`; declare its `target.application`.
