---
section: Breaking
issue: 812
---

**A2A is the real protocol, v1.0 — the one breaking change of A2A in 0.1.1, with no 0.1.0 wire shim**
(#812, epic #805): an application's `@A2AExpose` is an A2A v1.0 agent (Agent Card, JSON-RPC
`SendMessage` / `SendStreamingMessage` / `GetTask` / `ListTasks` / `CancelTask` / `SubscribeToTask`,
durable tasks, direct `Message` replies, file parts, the mesh and skills extensions at
`https://agboss.dev/a2a/mesh/v1` and `https://agboss.dev/a2a/skills/v1`), and `@A2AAgent` /
`A2AClient` call any v1.0 agent. The 0.1.0 wire — `POST <url>/execute`, `/resume`, `/cancel`, the
`agboss-mesh` header, `A2AExecutionResponse` — is gone, so a 0.1.1 client and a 0.1.0 server do
not interoperate; upgrade both sides together. The leftover 0.1.0 wire exports `A2AStatus`,
`A2AEvent`, `A2AExecutionRequest` and `A2AExecutionResponse` are removed from `@agboss/core/a2a`.
MCP is unchanged.

Migration:

- `@A2AAgent({ target: { start } })` → `target: { skill }` (the skill id is the exported start's
  name, so the value stays); `cancel(threadId)` → `cancel(taskId)`; `call.threadId` →
  `call.contextId`.
- A caller resolver's `request.route` (`A2ARoute.Execute` / `Resume` / `Cancel`) → `request.operation`
  (`A2AOperation`); a resume is `A2AOperation.SendMessage` with a `taskId`.
- `a2aHttpListener(app, { …, publicUrl })`: where callers reach the listener, the Agent Card's
  interface URL (an environment text field in practice).
- `@A2AExpose` takes a `description`, and an exposing application keeps its tasks in an
  `A2ATaskRepository` its instances share (`[a2a.task-store-not-shared]`).
- `@Application({ retention: { a2aTasks, a2aMessages, a2aFiles } })` set how long a finished task
  (and so how long a resent `messageId` is answered), a direct reply and a task's files are kept
  (defaults `hours(24)`, `minutes(15)`, `a2aTasks`).
- A client that sends to an AGBoss peer resends an ambiguous accept only within the peer's
  declared `idempotencyRetention`; never to a foreign peer.
