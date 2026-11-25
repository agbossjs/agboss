---
section: Breaking
issue: 1320
---

**A2A types of its own, stores in `/stores`, one caller error, `Cancelled`** (#1320): `@agboss/core/a2a`
no longer re-exports the official SDK's generated types (`Part` with `$case`, `Message`, `Task`, `TaskState`,
`Artifact`, `AgentCard`, `AgentSkill`). It gives `A2APart` (`text`, `data`, `raw`, `url`, `A2APart.fromFile`),
`A2AMessage`, `A2AArtifact`, `A2ATask`, `A2AAgentCard`, `A2AAgentSkill` and `A2AStreamEvent`, discriminated by
`kind`, with `Date` times; `getTask`, `cancel`, `agentCard`, `onEvent` and `A2ATaskResult` give them. `send` and
`reply` take `A2AMessageInput` — a text, or `{ text?, data?, files? }` with at least one of them, or parts —
and read a stored file (`fileId`) before sending it. Every public method of `A2AClient` rejects, never throws
before its promise. `A2ATaskRepository`, `A2ADirectMessageRepository` and their in-memory and SQLite classes
are exported by `@agboss/core/stores`, no longer by the root or `/a2a`. `A2ACallerRejectedError` is
`A2AError.CallerRejected`. Every `Canceled` is `Cancelled` (`A2ATaskState.Cancelled`, `A2ACancelOutcome`,
`A2AError.TaskCancelled`, `A2AErrorKind.TaskCancelled`, `isCancelled`); the wire's `TASK_STATE_CANCELED` is
unchanged. `A2AError.Deadline.deadlineAt` and `A2ATaskStatus.cancelRequestedAt` are `Date`s.
`A2ATaskState` gains `AuthRequired` and `Unspecified`, a remote agent's. `@A2AExpose` is gone: use
`@A2AEndpoint`. `a2aHttpListener({ maxTaskDuration })` is gone.
