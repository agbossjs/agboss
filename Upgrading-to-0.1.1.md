# Upgrading to 0.1.1 — A2A is the real protocol

0.1.1 has one breaking change in A2A: `@A2AExpose` / `a2aHttpListener` serve **A2A v1.0**
([the specification](https://a2a-protocol.org/v1.0.0/specification/)) and `@A2AAgent` / `A2AClient`
call any v1.0 agent. The 0.1.0 wire is gone, with **no shim**: its `POST <url>/execute`, `/resume`
and `/cancel`, its `agboss-mesh` header and its `A2AExecutionResponse`. A 0.1.1 client and a 0.1.0
server do not interoperate — upgrade both sides of an A2A call together. MCP is unchanged. A v0.3
agent is an explicit `A2AProtocolError` naming its version.

What you get: an Agent Card at `<base>/.well-known/agent-card.json`, JSON-RPC (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`), durable tasks that
outlive their connection, one execution per `messageId`, direct `Message` replies, file parts, and
the AGBoss guarantees as two extensions
([mesh](A2A-Mesh-Extension), [skills](A2A-Skills-Extension)) — see [A2A](A2A).

## Migration

| 0.1.0 | 0.1.1 |
| --- | --- |
| `@A2AAgent({ target: { application, start } })` | `target: { application, skill }` — the skill id is the exported start's name, so the value stays; `target` itself is optional (a foreign agent has none) |
| `client.cancel(threadId)` | `client.cancel(taskId)` — cancels that task only; `call.threadId` is `call.contextId` |
| `A2ARoute` (`Execute`, `Resume`, `Cancel`), `request.route` | `A2AOperation`, `request.operation`; a resume is `SendMessage` with a `taskId` |
| `a2aHttpListener(app, { expose, callerResolver })` | adds `publicUrl`: where callers reach it, the card's interface URL |
| `@A2AExpose({ name, version, exports })` | adds a `description` (`[a2a.expose-description-required]`) and, for a card worth finding, `skills: { [start]: { tags } }` (`[a2a.skill-tags]`, a warning) |
| `A2AExecutionResponse`, `A2AStatus`, `A2AEvent`, `A2AExecutionRequest` | removed; a call returns the remote output (`execute`) or an `A2ATaskResult` (`send`) |
| `A2ARemoteError`, `A2AContract` | `A2ARemoteCallError`, `A2AClientContract`; the adapter types are gone |
| the mesh envelope in the `agboss-mesh` header | `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` |
| a run report in the response body | `task.metadata[uri].report` |
| `describe --json` exports and imports by `start` | by `skill`; a foreign `@A2AAgent` is listed with `foreign: true` — re-save your federation snapshots (a 0.1.0 snapshot is still read) |
| — | `@Application({ retention: { a2aTasks, a2aMessages, a2aFiles } })`: how long a finished task (and a resent `messageId`'s answer), a direct reply and a task's files are kept — defaults 24 h, 15 min, `a2aTasks` |
| — | an application serving A2A on shared leases lists a task store they share (`[a2a.task-store-not-shared]`) |

A disconnect no longer cancels a run: the task goes on, and `GetTask` / `SubscribeToTask` read it.
A client resends an ambiguous accept only to an AGBoss peer, within the retention its card declares
— never to a foreign peer.

The full list of changes of the release is in the [Changelog](Changelog).
