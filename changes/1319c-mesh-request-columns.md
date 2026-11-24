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
has come **and that have an answer**: a request still running keeps its key, so a repeat meets
`mesh.request-in-progress` and the call never runs twice. The sweep passes `now`; the `meshAnswers`
retention is no longer read by it. SQLite: `mesh_requests(tool, request_hash, expires_at)` in the
baseline schema (no migration). Store follow-up: PostgreSQL and MongoDB need the same three columns
and the guarded `deleteExpired(now)` (the 0.1.1 baseline, train T4).
