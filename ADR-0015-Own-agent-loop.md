# ADR-0015 — Own agent loop instead of `createAgent`

- **Status:** Accepted (supersedes the agent-loop parts of [ADR-0003](ADR-0003-Typed-tools-and-MCP-facades) and [ADR-0006](ADR-0006-Quality-gated-reasoning-attempts))
- **Issue:** #150 (spike #114, parent #119)

## Context

Agents ran LangChain's `createAgent` with middlewares for usage, budget, approval and the tool call
limit. The whole loop was one opaque step: an approval ended the loop and, on resume, the agent ran
again from the start — the model was asked again and the decided call had to be recognised by its
arguments. A crash could repeat finished tool calls; parallel calls, a defined order of checks at the
move boundary and per-agent limits could not be expressed. The spike (#114) showed an own loop on
LangGraph handles all of this with stock primitives.

## Decision

- Each agent is a **compiled subgraph** added as one workflow node: `input → model → boundary →
  approval → tool × N (Send) → collect → model … → agent-replyWith`.
- Every finished tool call is **stored under its `callId`**; nothing finished is repeated. A crash is
  not a pause: a call running when the process died runs again with the same `callId`, which tools
  use as their idempotency key (at-least-once).
- The **move boundary order** is fixed: tool judges → agent judges (`beforeToolCall`) → approval →
  run → `afterToolCall` (tool, agent); judge points are empty until #123.
- **One call per pause**; approval goes through an internal interface backed by the pause seam.
- **Limits per call of the agent**: `modelCalls` 12, `toolCalls` 20; hitting one fails the run with
  `agents.<name>.limits.*`.
- The loop owns its hooks (usage per call, run budget before a call, tool timeouts); `createAgent`,
  the middlewares and the `langchain` dependency are removed.
- **Reasoning attempts (#79) are removed** with it; #123 brings the idea back as
  `BeforeAgentAnswerJudge` + `maxSendBacks`. Turn migration 5 drops the `attempts` column.

## Consequences

- Resume and restart continue the same step; the model is not re-asked for a finished turn.
- Tests need scripted models picked by position (#135), never by call order.
- Side-effecting tools must honour their call's idempotency key (`ctx.callId` then;
  `executionContext.step.idempotencyKey` since #280); the docs say so.
- A durable checkpointer is required for crash recovery across processes (#121).
