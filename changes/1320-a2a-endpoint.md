---
section: Breaking
issue: 1320
---

**`@A2AEndpoint`: one typed skills list, a `ttl` of its own, and its own rows** (#1320): an A2A
contract is `@A2AEndpoint({ name, version, description, ttl: { tasks, messages }, skills, defaultSkill?,
provider?, cardFileFields? })`, listed in `@Application({ endpoints })` (was `exposes`) and served by
`a2aHttpListener(app, { endpoint, publicUrl })` (was `expose`). `skills` is one list of
`@WorkflowStart` classes or `{ start, tags?, examples?, filePolicy?, reply?, cardFileFields? }` — the
`exports` list and the map of skills by the start's name are gone, and so is the listener's `provider`
(it is the endpoint's). `ttl` is required: `tasks` is how long a finished task is kept after its last
status change (`Ttl.Forever` keeps it), `messages` how long a direct reply is kept and its `messageId`
deduplicated (above the 30 s lease): `@Application({ retention: { a2aTasks, a2aMessages } })` is
gone, and the card advertises the endpoint's own. Each endpoint's rows are its own: `A2ATaskRecord`,
`A2AMessageRecord` and `A2ADirectMessageRecord` name their `endpoint`, the sweep of one endpoint never
removes another's (`A2ATaskRepository.deleteExpired(cutoffsByEndpoint)` and
`A2ADirectMessageRepository.deleteExpired(cutoffsByEndpoint, limit)` replace
`deleteTerminalByStatusAtBefore` and `deleteByCreatedAtBefore`; a direct reply is swept by when it was
kept), and a task or a message id of one endpoint is "not found" or "reused" at another that shares its
store. `publicUrl` may be a function, asked at the first request (a server that listens on port 0).
Rules: `[a2a.ttl-invalid]`, `[a2a.duplicate-skill]`; renamed `[a2a.endpoint-description-required]`,
`[application.not-an-endpoint]`, `[application.duplicate-endpoint]`,
`[application.endpoint-unknown-start]`, `[application.endpoint-unlisted]`. `@A2AExpose` (the form of
0.1.0) stays only as a shim that records an endpoint until its test users are flipped.
