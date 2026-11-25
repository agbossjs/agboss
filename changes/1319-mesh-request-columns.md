---
section: Breaking
issue: 1319
---

**The mesh request store keeps what each request asked and when it expires** (#1319c).
`MeshRequestRecord` has `tool`, `requestHash` (`sha256:` of the tool and its arguments),
`expiresAt` (`createdAt` + `@Mesh({ deduplicationTtl })`), `attemptId` and `lockedUntil`: a request
that runs is held by its attempt under a lease (`MESH_REQUEST_LEASE_MS`, 30 s) that the running
handler renews every third of it. `saveIfAbsent` claims a key, saves a `response` the record already
carries (a replayed-signature marker is finished at once), and takes over a key kept without an
answer only when its lease has lapsed and the call is the same (tool and request hash). `renewLease`,
`saveResponse` and `deleteByKey` take the attempt id and write nothing (return `false`, fenced) for
a stale attempt. A trusted MCP call that repeats an idempotency key with another tool or other
arguments is refused `mesh.idempotency-key-reused` (`MeshRefusalCode.IdempotencyKeyReused`), one
inside the lease meets `mesh.request-in-progress`; a handler that crashed frees its key once its
lease lapsed. `MeshRequestRepository.deleteExpired(now)` removes the rows whose `expiresAt` has
come and that are answered or whose lease has lapsed; a handler that keeps renewing is never
swept. SQLite: `mesh_requests(tool, request_hash, attempt_id, expires_at, locked_until)` in the
baseline schema (no migration). Store follow-up (train T4): PostgreSQL and MongoDB need the same
columns and conditional writes (`UPDATE ... WHERE attempt_id = ? AND response IS NULL`, the
takeover as one conditional update on `locked_until <= now` with the same tool and hash, the sweep
as above); Redis: a hash per key with the attempt id and a Lua script for the conditional
renew/answer/delete/takeover, the key's TTL at `expiresAt`.
