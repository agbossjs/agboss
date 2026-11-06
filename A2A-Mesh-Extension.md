# The AGBoss mesh extension — `https://agboss.dev/a2a/mesh/v1`

A profile extension of A2A v1.0 (spec §4.6): what an AGBoss application adds to a call between two
AGBoss applications — the caller's **call chain** (loop and hop limits), its **budget** and
**deadline** left, and the receiver's **signed run report** of what the call spent. An agent that
does not support it is called without it, and the caller says so (`mesh: false`); nothing of it is
ever assumed. A breaking change takes a new URI. (#809 the client, #810 the server; to be mirrored at
agboss.dev.)

## Declaration — the Agent Card

```json
{
  "uri": "https://agboss.dev/a2a/mesh/v1",
  "required": false,
  "params": { "idempotencyRetention": "PT86400S" }
}
```

- `params.idempotencyRetention` (ISO 8601 duration of seconds): how long the agent deduplicates a
  `messageId` per caller — the same message resent within it gets the same task. Its presence makes
  the agent an **AGBoss peer** to a client: an ambiguous send may be resent with the same
  `messageId` within it, never to any other agent.

## Activation

The client sends `A2A-Extensions: https://agboss.dev/a2a/mesh/v1` (and a W3C `traceparent`) with a
`SendMessage`; the agent **echoes** the URI in its answer's `A2A-Extensions` when it activated it. A
client treats a call whose answer does not echo it as one without the mesh.

## The envelope — `message.metadata[uri].envelope`

A compact JWS of type `agboss-mesh`: signed `EdDSA` with the caller's Ed25519 key, or unsecured
(`alg: "none"`, a claim only). Its payload, schema 1:

| Field | |
| --- | --- |
| `issuer` | the calling application |
| `audience` | the receiving application — **required when signed** |
| `origin` | the calling execution: `rootExecutionId`, `executionId`, `workflow`, `step.idempotencyKey` |
| `callChain` | `[{ application, start, executionId }]`, the first caller first, the caller last |
| `issuedAt`, `expiresIn` | the replay window (`PT60S`) |
| `bodyHash` | `sha256:<hex>` of the RFC 8785 canonical JSON of the `Message` as sent, with `metadata[uri]` removed (and `metadata` when it is then empty) |
| `budget` | `{ remaining: "<USD decimal>", currency: "USD" }` — what the caller may still spend |
| `deadline` | `{ remaining: "<ISO 8601 duration>" }` — how long the caller still waits |

## The receiver's checks, in order, before anything runs

1. The **audience**: addressed to another application → `401 { "code": "mesh.audience-mismatch" }`;
   signed and addressed to none → `401 mesh.audience-missing` — before any signature is looked at.
2. A known issuer's **signature** (`mesh.signature-invalid`), **replay window**
   (`mesh.envelope-expired`) and **body** (`mesh.body-mismatch`), each `401`.
3. The **chain**, on every envelope: the receiver's own `(application, skill)` already in it, or the
   chain as long as its `maxMeshHops` → a `REJECTED` task, nothing run, with
   `status.message.metadata[uri] = { "code": "limit.mesh-loop" | "limit.hops", "details": { "entry",
   "chain", "maxMeshHops"? } }`.
4. Trusted — the authenticated caller is the envelope's verified issuer — its `budget` and
   `deadline` bind the execution, its `origin` is the execution's.

A failed task's stable code is in `status.message.metadata[uri].code`; only the two mesh limits
carry `details`, no other error's facts leave the application.

## The run report — `task.metadata[uri].report`

On a completed task of a trusted caller (and on its stream's last status update): a compact JWS of
type `agboss-mesh-report`, signed by the receiver, payload `{ schema: 1, issuer, executionId (the
task's id), spend: { total, currency: "USD" }, bodyHash (the first message's), issuedAt }`. The
caller verifies it with the issuer's key, its own `bodyHash` and its task's id, and charges
`max(verified spend, contract price)` — once, whichever of its passes reads it.

See [A2A → §6.1](A2A#61-the-mesh-on-the-a2a-v10-listener-810) for the framework's side.
