---
section: Breaking
issue: 1319
---

**The mesh request store keeps what each request asked and when it expires** (#1319c).
`MeshRequestRecord` has `tool`, `requestHash` (`sha256:` of the tool and its arguments) and
`expiresAt` (`createdAt` + `@Mesh({ deduplicationTtl })`); `saveIfAbsent` also stores a `response`
the record already carries (a replayed-signature marker is finished at once). A trusted MCP call
that repeats an idempotency key with another tool or other arguments is refused
`mesh.idempotency-key-reused` (`MeshRefusalCode.IdempotencyKeyReused`), never answered with the
other call's result. `MeshRequestRepository.deleteExpired(now)` removes the rows whose `expiresAt`
has come and that have an answer, and those without one only `MESH_IN_PROGRESS_GRACE_MS` (1 hour)
after it: a request still running inside its window keeps its key (a repeat meets
`mesh.request-in-progress`, a replay is refused, a different body is `mesh.idempotency-key-reused`),
and a crashed handler frees its key after the window plus the grace. The sweep passes `now`; the `meshAnswers`
retention is no longer read by it. SQLite: `mesh_requests(tool, request_hash, expires_at)` in the
baseline schema (no migration). Store follow-up: PostgreSQL and MongoDB need the same three columns
and the same `deleteExpired(now)` (answered rows at `expires_at`, unanswered ones at `expires_at` +
grace; Redis keeps its keys with a TTL of window + grace) (the 0.1.1 baseline, train T4).
