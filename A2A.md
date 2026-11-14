# A2A (agent-to-agent)

`@agboss/core/a2a` works both ways:

- **Calling an A2A v1.0 agent** — another AGBoss application or any compliant agent (#809, on the
  official `@a2a-js/sdk`; [§4](#4-the-client-side--a2a-v10-809)): a `…A2AAgent` class that `extends
  A2AClient<In, Out>` with `@A2AAgent({ name, url, target?, input?, output?, price?, mesh?,
  allowedOrigins?, deps })`, listed in `providers` and injected into a `@Tool` or an `@Action`
  ([Components](Components)); `execute(input, call)` sends the input and returns the remote output,
  both validated by the contract's DTOs, `send(message, call)` an untyped call's `A2ATaskResult`.
- **Serving a workflow** — an `@A2AExpose` listed in `@Application({ exposes })`, served by
  `a2aHttpListener(app, { expose, callerResolver, publicUrl, base? })` as an **A2A v1.0 agent**
  (#808, [the specification](https://a2a-protocol.org/v1.0.0/specification/)): its Agent Card at
  `<base>/.well-known/agent-card.json` and the JSON-RPC 2.0 binding at `POST <base>`. Any A2A v1.0
  client calls it — the official SDK `@a2a-js/sdk`, which the server is built on, or another
  vendor's. This page is mostly about this side. (The 0.1.0 wire is gone, with no shim: [Upgrading to 0.1.1](Upgrading-to-0.1.1).)

## 1. Who calls — the caller resolver

The framework never guesses a tenant from a request. The host says who calls, for every request,
with a **caller resolver**: an ordinary `@Injectable` that `implements A2ACallerResolver<typeof
Start>`, listed in `@Application({ providers })` or a `@Workflow({ providers })` and created by the
application's container like any service — its own services through `deps`, its environment, its
hooks and a test's `override(…)` apply; never `new`.

<!-- snippet-context
import { Injectable, WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
export interface ApiKeyGrant {
  readonly clientId: string;
  readonly tenantId: string;
  readonly canAnswerPauses: boolean;
}
@Injectable()
export class ApiKeyDirectory {
  grantOf(_apiKey: string): Promise<ApiKeyGrant | undefined> {
    return Promise.resolve(undefined);
  }
}
@WorkflowStart({ name: "support-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class SupportWorkflowStart {}
-->

```ts file=shop.a2a-caller-resolver.ts
import {
  A2ACallerResolution,
  A2AOperation,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "@agboss/core/a2a";

@Injectable({ deps: [ApiKeyDirectory] }) // created by the container, like any service
export class ShopA2aCallerResolver implements A2ACallerResolver<typeof SupportWorkflowStart> {
  constructor(private readonly apiKeyDirectory: ApiKeyDirectory) {}

  async resolveCaller(
    request: A2ACallerRequest,
  ): Promise<A2ACallerResolution<typeof SupportWorkflowStart>> {
    const header: string = request.http.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      return A2ACallerResolution.unauthenticated({
        reason: "no API key",
        challenge: 'Bearer realm="a2a"',
      });
    }
    const grant = await this.apiKeyDirectory.grantOf(header.slice("Bearer ".length));
    if (grant === undefined) return A2ACallerResolution.unauthenticated({ reason: "unknown API key" });
    const isResume = request.operation === A2AOperation.SendMessage && request.taskId !== undefined;
    if (isResume && !grant.canAnswerPauses) {
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    }
    return A2ACallerResolution.resolved({
      tenant: { tenantId: grant.tenantId }, // the declared TenantContext's values: typed, required
      ownerId: grant.clientId, // the thread's owner — also who may answer its pauses
    });
  }
}
```

- `resolveCaller({ operation, taskId?, http })` gets the JSON-RPC method as an `A2AOperation`
  (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`),
  the task it names (a `SendMessage` with a `taskId` answers a task's pause), and the raw
  `IncomingMessage` — its headers and its socket (a client certificate for mTLS). The body is read
  first (up to `maxBodySize`, default 1 MB, else `413`) and decoded once — by the SDK's own decoder,
  the one the handler acts on, so `task_id`, a number or a key given twice names the same task to
  both — for the operation and the task only: nothing of it runs, and no header is written, before
  the resolver answers. Should the request the handler decodes ever differ from the admitted one,
  it is refused: `-32602`, `a2a.request-mismatch`.
- It answers with `A2ACallerResolution` only (`A2ACallerResolutionKind`; branded — a plain object
  does not compile): `resolved(caller)`, `unauthenticated({ reason, challenge? })` or
  `forbidden({ reason })`. `A2ACaller<typeof Start>` is the `tenant`, `ownerId` and `execution` of
  `app.execute(Start, …)`'s options — typed by the start's application: with a declared
  `TenantContext` its values are required ([Context and Authorization](Context-And-Authorization)).
- A single-tenant host says so: `resolveCaller() { return A2ACallerResolution.resolved({}); }` — it
  does not compile when the application declares a `TenantContext`. There is no default.

## 2. Serving — `a2aHttpListener(app, options)`

```ts no-check: ShopApplication and its workflow are not written out on this page
import { createServer } from "node:http";
import { createApp } from "@agboss/core";
import { a2aHttpListener } from "@agboss/core/a2a";

const app = await createApp(ShopApplication, { env: "prod" });

createServer(
  a2aHttpListener(app, {
    expose: ShopA2AExpose, // listed in @Application({ exposes })
    callerResolver: ShopA2aCallerResolver, // the class: its instance is the container's
    publicUrl: "https://shop.example", // where callers reach it: the card's interface URL
    base: "/a2a",
    // maxBodySize: kilobytes(1024), maxTaskDuration: minutes(10)
  }),
).listen(8080);
```

The listener takes the resolver's instance from the application's container when it is built: a
class neither the application nor any of its workflows lists stops it there —
`[a2a.caller-resolver-not-listed] ShopA2aCallerResolver is not listed …` — and an expose the
application does not list too: `[application.expose-unlisted]`; a `publicUrl` that is no absolute
http(s) URL is `[a2a.public-url-invalid]`. `app` is an `A2AApp` (`execute`, `resume`, `cancel`,
`resolve` of `App`): `createApp`'s app and `testWith`'s `app` both fit.

**The Agent Card** (`GET <base>/.well-known/agent-card.json`, `ETag`, `Last-Modified` — when the
listener built it, at its first request (#811) —, `Cache-Control: max-age=300`):
the expose's `name`, `description`, `version` and `provider`; one skill per exported start (its id
the start's name, its description the start's, `tags` from `@A2AExpose({ skills })`, default the
application's name; `inputModes` `text/plain` for a `WorkflowStartTextDto` start, else
`application/json`); `capabilities.streaming: true`, no push notifications; the skills extension
`https://agboss.dev/a2a/skills/v1` (`A2A_SKILLS_EXTENSION`) whose `params.skills[id]` holds each
skill's input JSON Schema, its `schemaHash` and each finish's output schema; `securitySchemes` from
`@A2AExpose({ security: [A2ASecurity.bearer()] })` (`.apiKey({ header })`,
`.oauth2ClientCredentials({ tokenUrl, scopes })`, `.mtls()` — any one accepted; described only, the
resolver enforces it); one interface `{ url: publicUrl + base, protocolBinding: "JSONRPC",
protocolVersion: "1.0" }`.

**The JSON-RPC binding** (`POST <base>`, `A2A-Version: 1.0` required — none means 0.3: `-32009`):

| Method | What it does |
| --- | --- |
| `SendMessage` | a new task (no `taskId`), or a follow-up answering one; blocking until the task is over or waits for its caller, or `configuration.returnImmediately` |
| `SendStreamingMessage` | the same, its changes as server-sent events: the task first, status updates (an agent's tool call as it starts: `WORKING` with the text `calling <tool>`, #848), the agent's answer text (never a judge's, router's or other internal model's, #1004) as chunks of the task's output artifact (`artifactUpdate` `<taskId>:output`: the stream's first chunk `append: false`, the next of the same step `append: true`; a retry or another step starts it anew `append: false`, a retracted step empties it, and a task that ends FAILED, CANCELED or REJECTED after text ends with an empty `lastChunk: true` before its last status, #1006), the finish's output replacing it (`append: false`, `lastChunk: true`), the last status (#833) |
| `GetTask` / `ListTasks` | the caller's tasks only (another's is `-32001`), newest status first, paged (`nextPageToken` `""` on the last page), by context, state and `statusTimestampAfter` — a task whose status changed at or after that time, as a2a.proto says ("greater than or equal"; #811: the SDK's own store filters `>`, the official TCK tests no boundary; #960: the store contract's own bound stays `>`, the server passes one millisecond before), a fraction below the millisecond rounded up to it; an RFC 3339 time with its offset only (one of no offset, which the server's zone would decide, is `-32602`); `totalSize` every task the filters match before paging, `pageSize` the page size used (#824) |
| `CancelTask` | that task only — never another of its context; one not started yet is fenced and `CANCELED` at once; one that is over `-32002` |
| `SubscribeToTask` | the task first, then its changes until it is over (`-32004` when it is over already) |
| push methods / `GetExtendedAgentCard` | `-32003` / `-32004` — the card declares no extended card, and an operation of a capability not declared is `UnsupportedOperationError` (spec §3.3.4; `-32007` is for an agent that declares one; #811) |

- **A message** names its skill in `metadata["https://agboss.dev/a2a/skills/v1"].skill` (optional
  with one export; else `-32602` listing the skill ids) and carries text parts (a text start) or one
  `data` part, checked against the start's input before anything is kept (`-32602`, `dto.invalid`,
  the fields and the schema in the error's `metadata`); a file part is `-32005` unless the start's
  input holds files (below). Its `contextId` is the task's thread (the caller's own, or one minted).
- **One task is one root execution**, under the task's id, kept in `A2ATaskRepository`
  (`@Application({ retention: { a2aTasks } })`). The same `messageId` from the same tenant and owner
  gets the same task — never a second run, on any instance; with other content it is `-32602`. A
  task whose start was lost (a crash right after it was accepted) is started by the resend, under
  the same id, once.
- **The task store is shared by the instances** (#824). "On any instance" holds only when every
  instance reads one store, so the store declares its backend (`static store = { backend }`, #825) and assembly checks it: an
  application that serves A2A on a lease store its instances share (any backend but `in-memory`)
  keeps its tasks on that backend, or on a kind known to be shared (`postgres`, `mongodb`). Anything
  else — the in-memory default, a store that declares no backend, SQLite beside PostgreSQL leases,
  a backend the rule does not know (an allow-list: never taken as shared) — does not assemble:
  `[a2a.task-store-not-shared]`, naming the store to list. Leases on the in-memory default: nothing
  to list; on SQLite: `SqliteA2ATaskRepository`; on PostgreSQL: `PostgresA2ATaskRepository`
  (`@agboss/postgres`); on MongoDB: `MongoA2ATaskRepository` (`@agboss/mongodb`); on Redis
  (coordination only, it keeps no A2A tasks): the A2A task store of the durable backend. A store of
  your own declares `static store: StoreDescriptor = { backend: "<kind>" }` and passes `a2aTaskContract`
  ([Your own store](Your-own-store)).
  Two listed task stores do not assemble either: `[di.ambiguous-implementation]` names both with their
  backends (#960). The recovery sweep removes a finished task with its messages, and a message whose
  task is gone once it is older than the retention (a follow-up saved while its task was removed, #960),
  so its id is free again. A status a store does not know a key of is kept as written.
- **A task outlives its connection**: a caller that disconnects never cancels it; it reads it again
  with `GetTask` or `SubscribeToTask`. `maxTaskDuration` gives every task an execution deadline.
- **Pauses**: a pause the caller answers is `TASK_STATE_INPUT_REQUIRED`, its pauses (`pauseId`,
  `kind`, `ask`) in the status message's `data` part; a follow-up `SendMessage` with the same `taskId`
  answers it — one `data` part `{ pauseId?, decision }` (`pauseId` optional with one pause) or a text
  reply (read by the role's reply interpreter; not understood: `-32602`, the pause still pending). A
  pause of another task is `-32602`; one a cancel or another answer took first — or whose tree ended — `-32004`, always with the code
  `a2a.pause-closed`, the `reason` (`answered`, `expired`, `cancelled`, `withdrawn`, `tree-ended`, `reassigned`) and when it
  closed in its error metadata, and a fixed text per reason, never an error's own message. A pause only
  its channel answers is `TASK_STATE_WORKING`, "awaiting <channel> out of band".
  A pause with a deadline (`expiresIn`, #941) refuses a follow-up at the deadline with `reason: expired`; the expiry look then
  moves the task `INPUT_REQUIRED` → `WORKING` → `COMPLETED` (the channel decided) or `FAILED` (`step.pause-expired`, or
  `run.deadline-exceeded` when the run's deadline bound the pause).
- **Ends**: a finish is `TASK_STATE_COMPLETED` with one artifact named by the finish (a text part for
  a `WorkflowFinishTextDto` output, else a `data` part); a failure `TASK_STATE_FAILED` with its stable
  code in `status.message.metadata["https://agboss.dev/a2a/mesh/v1"].code` and that code's fixed text
  — never the error's own text, which may carry PII; an unexpected failure of the server is `-32603`
  "the request failed".
- **One artifact in every view** (#833): the text a run streams and the finish's output are one
  artifact, `<taskId>:output`. A client that applies every stream event as A2A v1.0 says (append to
  the artifact of that id, or replace it) ends with the artifacts `GetTask` returns; one that joins
  the artifacts' text reads the answer once. A task that ends without completing has no output:
  the stream's view keeps the text streamed so far (never a `lastChunk`), and `GetTask` shows no
  artifact.
- **A slow or idle stream** (#1008): the SSE writer waits for the socket to drain before the next
  event, and the run never waits for a reader (a reader that takes nothing for 60 s on the
  application's `Clock` is cut). Each subscriber's queue joins the text deltas of one step and holds
  at most 1 MiB of text and 1000 events; a subscriber over that is dropped with a clean close
  (`stream.subscriber-dropped` in the log) and subscribes again with `SubscribeToTask`. An idle
  stream writes the comment `: keep-alive` every 15 s of the `Clock`, so proxies with idle timeouts
  do not cut it. A throwing `onStream` listener is logged once per execution
  (`stream.listener-failed`, with the `executionId` and `tenantId`, never the text); the run and
  the other listeners go on.

| The resolver returns                       | The caller gets                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `resolved({ tenant, ownerId, execution })` | the operation, for that tenant and owner                                                            |
| `unauthenticated({ reason, challenge })`   | `401`, `WWW-Authenticate: <challenge>`, `{ "code": "a2a.caller-unauthenticated", "error": reason }` |
| `forbidden({ reason })`                    | `403`, `{ "code": "a2a.caller-forbidden", "error": reason }`                                        |
| it throws (or answers anything else)       | `500`, `{ "code": "a2a.caller-resolution-failed", "error": "the caller could not be resolved" }`    |

- A refused request **runs nothing**: no task, no `onExecutionStart`, no thread, no record, no model
  call — and never as the default tenant. A streaming caller gets the real status too.
- The host's `reason` goes on the wire (its own wording); an exception's text never does.

### Files — `raw` and `url` parts (#859)

A skill takes files when its start's input DTO has `A2AFileDto` fields — `@Nested(A2AFileDto)` for
one, `@ListOf(A2AFileDto)` for several (`@agboss/core/a2a`). A step holds a file as a descriptor
(`mediaType`, `filename`, `sha256`, `sizeBytes`, and where its bytes are: `fileId` in the store,
`inline` base64, or `url`) and reads its bytes with the `A2AFiles` service (`deps: [A2AFiles]`,
`read(file)`); it makes one with `save({ bytes, mediaType, filename })` or names one by reference
with `fromUrl(url, { mediaType, filename })`. A finish whose output holds files —
`WorkflowFinishFileDto { file }`, `WorkflowFinishFilesDto { files }`, or any DTO with file fields —
answers with one file part per file (`metadata[skills-uri].field` naming its field), then one
`data` part of its other fields. The card lists the media types a skill takes in `inputModes` and
what `A2AFiles.save` takes — the application's `a2aFiles`, else the defaults — in `outputModes`
(#904).

**The card never asks for a file field in a data part** (#904; a finish's outputs too, #916):
`@A2AExpose({ cardFileFields })`, per skill too (`skills: { [id]: { cardFileFields } }`, over the
expose's; an invalid value or a skill not exported is `[a2a.file-options-invalid]` /
`[a2a.unknown-skill-option]`):

| `A2ACardFileFields` | The skill's `input` schema and each finish's output schema in the skills extension |
| --- | --- |
| `Extension` (default) | the file fields left out (and out of `required`), declared beside them as `files: { <field>: { list, optional, mediaTypes } }` (the input) and `outputFiles: { <finish>: { <field>: { list, optional, mediaTypes } } }` (#916) |
| `Marker` | each file field kept as `{ "x-agboss-file-part": { list, optional, mediaTypes }, description }` (#916: the declaration `Extension` makes; was `true`), never in `required` — a strict ajv compiles it once the keyword is declared (`ajv.addVocabulary(["x-agboss-file-part"])`) |

The media types are those the skill takes (its `files`, else the application's `a2aFiles`) for the
input, what `A2AFiles.save` takes for the outputs. Either way a standard validator accepts a data
part without file fields; the entry names the mode (`cardFileFields`), `agboss describe --json` names
it per export, and the AGBoss client's schema check — the same under either mode — compares its
input DTO without its file fields, then its file fields with the declared ones (a missing required
one, one declared as text, a list against one file, an optional one the skill requires, one the
skill does not take as a file), and its output DTO the same way against each finish's (a file it
requires that the finish does not give or gives optionally, a list against one file, a field the
finish gives as files that it reads as data).

| Rule | What happens |
| --- | --- |
| where a file goes | into the field its part names in `metadata["https://agboss.dev/a2a/skills/v1"].field`; unnamed ones in order — each one-file field not filled yet takes one, the first list the rest; one left over `-32602 a2a.too-many-files-for-field` |
| a data part naming a file field | `-32602 a2a.file-field-in-data` — a descriptor is the server's, never the caller's, with file parts or without |
| a file below the top level | `[a2a.nested-file-field]` at assembly — an exported start's input, its finishes' outputs and an `@A2AAgent`'s DTOs hold `A2AFileDto` in top-level fields only; a client built with such a contract refuses to call |
| limits | `@A2AExpose({ skills: { [id]: { files } } })` over `@Application({ a2aFiles })`: `maxFileSize` (64 KB), `maxTotalFileSize` (64 KB), `maxFiles` (5) — `-32602 a2a.file-too-large` / `a2a.files-too-large` / `a2a.too-many-files`; `[a2a.file-options-invalid]` at assembly |
| media types | `allowedMediaTypes` (PNG, JPEG, WebP, GIF, PDF, plain text, Markdown, CSV, JSON): another `-32005 a2a.file-media-type`; the bytes checked against the declared type (signatures, valid UTF-8, JSON) — `-32602 a2a.media-type-mismatch` |
| a file by `url` | fetched once at the admission, before the task is kept: `https:` on an origin of `allowedFileOrigins` only (none listed: `a2a.file-url-not-allowed`; another `a2a.file-origin-denied`), `GET`, redirects followed by hand — at most 3, each target's origin checked —, never an address of a range of the IANA special-purpose registries that is not globally reachable — loopback, private, link-local, CGNAT, `192.0.0.0/24`, benchmarking, documentation, reserved, multicast, unique-local, site-local, `2001::/23`, `64:ff9b:1::/48`, … — nor an IPv6 one carrying such an IPv4 (IPv4-mapped, -translated, -compatible, NAT64 `64:ff9b::/96`, 6to4: checked as that IPv4; #904) (the lookup's answer checked, `a2a.file-address-denied`), never a url with a user or a password (`a2a.file-origin-denied`, on a redirect too; #904), never through a proxy — the fetch has no agent and its own connection (the guarded lookup names the addresses, a raw TCP socket is connected to one of them, its remote address is checked before any byte, then TLS starts on that socket, with the host as SNI), so `NODE_USE_ENV_PROXY` / `--use-env-proxy` / `HTTPS_PROXY`, a replaced `https.globalAgent` or `global-agent` never carry it: behind a proxy the lookup would check the proxy's address only (#916); a deployment whose egress must go through a proxy takes no file by url. What holds: **0 bytes to a denied peer** (no TCP payload, no ClientHello, no request); **an allowed peer whose request gets an agent swap may see a TLS ClientHello, but no HTTP byte** (the request is refused `a2a.file-address-denied` and its TLS socket destroyed, also when the request's constructor throws; #1022); pass-through wrappers of `net` / `tls` / `ClientRequest` (APM agents) work, one that reroutes the connection is refused with nothing sent, and a `net` patch that lies about `remoteAddress` cannot be detected. Each request is one OpenTelemetry `CLIENT` span (`@opentelemetry/api`, a no-op without an SDK; method, status, `server.address`, `server.port`, `url.full` without query or fragment; no trace header is sent; not in Langfuse's isolated provider; dd-trace's http plugin does not see it unless Datadog's OpenTelemetry `TracerProvider` bridge is registered; #1021) —, the read stopped at `maxFileSize`, bound to the request's end and `a2aHttpListener({ fileFetchTimeout })` (10 s; `a2a.file-fetch-failed`) |
| a resend | the same `messageId` with the same bytes (their SHA-256) or url gets the same task, nothing fetched again; other bytes `-32602 a2a.message-id-reused` |
| concurrent duplicates | the same message sent again while its file is fetched joins that fetch: each url fetched once on a listener (the last request to leave aborts it); across instances each fetches at most once (#904) |
| a follow-up | text or data only: a file `-32005` |
| `maxBodySize` | unset: 1 MB, or room for the largest `maxTotalFileSize` as base64 and 256 KB more |

**Where the bytes are.** With no `A2AFileRepository` listed, a file rides inline in its task's own
records (the checkpoint, the task's output) — silently up to 64 KB, with the warning
`[a2a.inline-files-without-store]` up to 256 KB (an error under `--strict`), above it
`[a2a.file-store-required]`. A listed store keeps it under the task (`InMemoryA2AFileRepository`,
`LocalDiskA2AFileRepository` on the environment's `a2aFilesPath`, `S3A2AFileRepository` — a bucket
every instance reaches, on plain `fetch` with Signature Version 4: `a2aS3Bucket`, `a2aS3Region`,
`a2aS3Endpoint?` (an S3-compatible store), `a2aS3Prefix?`, `a2aS3AccessKeyId`,
`a2aS3SecretAccessKey`; every key within S3's 255-byte segments and 1024-byte keys for every valid id — a long id in pieces, one past 300 characters as its digest —, a file's metadata in its object's body, `a2aS3Prefix` at most 99 bytes (#904) —, or your own, proved by
`a2aFileContract`); on leases the instances share, one host's store with files above 256 KB is
`[a2a.file-store-not-shared]`. A task's files are its own: a step reads no other task's, a task's
artifact serves only its own. They are removed `@Application({ retention: { a2aFiles } })` after
the task is over (default and at most `a2aTasks`) — never while it waits, however long an
`INPUT_REQUIRED` task is paused.

**The client.** `execute(input)` sends `A2AClientFile.fromBytes(bytes, { mediaType, filename })`
(a `raw` part) or `A2AClientFile.fromUrl(url, …)` (a `url` part) in an input's file fields, a
stored file of the calling task read first; an answer's file parts fill the output DTO's file
fields (a foreign agent's unnamed parts into `WorkflowFinishFileDto` / `WorkflowFinishFilesDto`,
or the DTO's only file field), never a descriptor from a data part; `send` gives
`A2ATaskResult.files`; `client.downloadFile(file, { maxSize?, signal? })` gives the bytes — a
`url` through the client's own fetch, on its origins only.

A pause's decision never carries a file (#900): a follow-up `{ pauseId?, decision }` holding an
object shaped as an `A2AFileDto` — a `mediaType` with a `fileId`, `sha256`, `inline` or `url` — at
any depth is `-32602 a2a.file-field-in-data`, nothing resumed (the scan bounded: 64 levels, 10 000
values, else `a2a.answer-shape`).

### Direct replies — `A2AReply.Message` (#860)

A skill may answer with a `Message` instead of a task — a quote, a lookup, a classification:
nothing to pause for, nothing to follow up.

```ts no-check: the two starts and their workflows are not written out on this page
import { A2AExpose, A2AReply } from "@agboss/core/a2a";

@A2AExpose({
  name: "quotes-a2a-expose",
  version: "1.0.0",
  description: "Answers price questions at once; acknowledges orders as tasks",
  exports: [QuoteWorkflowStart, OrderWorkflowStart],
  skills: { "quote-workflow-start": { reply: A2AReply.Message } }, // default A2AReply.Task
  defaultSkill: QuoteWorkflowStart, // a message that names no skill runs it
})
export class QuotesA2AExpose {}
```

- **The answer.** `SendMessage` returns a `Message` (no `taskId`): the finish's output as a text
  part, a data part or file parts (#859), `metadata[skills-uri].finish` its finish and, for a
  trusted caller, the signed run report in `metadata[mesh-uri].report`. `returnImmediately` changes
  nothing; `SendStreamingMessage` is one frame — the message — then the end; `GetTask` of it, or a
  follow-up naming the skill with a `taskId`, is `-32001`.
- **Stateless, checked at assembly** on every node of the skill's workflow (fail closed: a node
  another start reaches counts): no pause (a question step, a question role, a tool with a
  channel — `[a2a.message-skill-pause]`), no fenced effect, `OutboundCalls` or `@A2AAgent` in any
  `deps` a node or a tool reaches (`[a2a.message-skill-effect]`), only `@Tool({ readOnly: true })`
  tools and no `@McpTool` (`[a2a.message-skill-tool]`), no `compensateWith` / `committedBy`
  (`[a2a.message-skill-compensation]`), no child workflow or recursion
  (`[a2a.message-skill-child]`). Reading a `@Rag` and the message's files (`A2AFiles`) is fine. A
  `reply` for no export, a `defaultSkill` that is none: `[a2a.unknown-skill-option]`.
- **Once per `messageId`.** The reply is kept in the application's `A2ADirectMessageRepository`
  (in memory by default; `SqliteA2ADirectMessageRepository`, `PostgresA2ADirectMessageRepository`,
  `MongoA2ADirectMessageRepository`; your own passes `a2aDirectMessageContract`) for
  `@Application({ retention: { a2aMessages } })` (default `minutes(15)`, published on the card as
  the mesh extension's `messageIdempotencyRetention`): a resend gets the same message, a concurrent
  duplicate waits for it (the store read every 250 ms, bounded) — the model is called and charged
  once. A message's id is claimed among the A2A task store's messages in the same atomic write, so
  one id is one message across both reply modes: another message under it, a task's or a direct
  one, is `-32602 a2a.message-id-reused`. So the direct store lives on the task store's backend —
  `[a2a.message-store-not-shared]` otherwise.
- **Bounded attempts.** An attempt's run stops at 25 s (and when its caller disconnects: its model
  calls abort, its step slots free) within its row's 30 s in flight; it is never continued by a
  recovery (an instance taking its lease over ends it as cancelled) — its caller waits for this
  pass alone. That instance keeps, for a skill that can call a model, one call of unknown cost in
  the run's record, as a lost pass of #853: `spend.unknownCalls` 1, a line `lost-pass:<workflow>`
  of no amount (`CostSource.Unknown`, ledger key `unknown:lost-run:<tenantId>:<runId>`) — what
  `agboss records export` writes — counted in `agboss.instance.costs.unknown`. The message of an
  attempt lost to a crash is taken over by exactly one resend or by the sweep, which removes its
  files. A failed attempt keeps nothing: a resend runs it again.
- **A live attempt is never swept.** The sweep removes completed replies only, the oldest first,
  once `retention.a2aMessages` passed since their message was accepted; an attempt in flight keeps
  its row, its id's claim and its reply to come however old its message is. A message taken over
  is accepted anew — its retention counts from the takeover — so a reply a takeover keeps is never
  thrown away under a waiting resend.
- **The client.** `A2AClient` takes a `Message` answer without waiting for a task; a message with no
  output it can read is `A2ARemoteCallError` `no-task`. For a skill whose card says `reply:
  "message"`, an ambiguous send is resent with its `messageId` only within the card's
  `messageIdempotencyRetention` (15 min when it declares none) — never the tasks' 24 h; past it the
  call fails closed, `OutboundCallUnreconciledError`.

## 4. The client side — A2A v1.0 (#809)

The client speaks A2A v1.0 (`https://a2a-protocol.org/v1.0.0/specification/`) on the official SDK;
the 0.1.0 wire is gone, on both sides ([Upgrading to 0.1.1](Upgrading-to-0.1.1)).

- **Discovery.** `url` is the agent's base URL: its card is read from
  `<url>/.well-known/agent-card.json` on first use and kept `cardTtl` (5 minutes). Before anything
  is sent it is checked: an A2A 1.0 interface on JSON-RPC or HTTP+JSON (a v0.3-only card is
  `A2AProtocolError` with `protocolVersions: ["0.3.0"]`); the named `target.skill` among its skills
  (`[a2a.unknown-skill]`; optional with one skill); when an AGBoss peer declares the skill's schemas
  (the skills extension `https://agboss.dev/a2a/skills/v1`), the skill's input must accept the input
  DTO and the output DTO every finish output (`[a2a.schema-mismatch]`, compared like
  [§8](#8-the-federation-check-398-pr-4)) — both `A2AContractError`.
- **Some finishes only (#916).** By default a typed client's `output` covers every finish of its
  skill. `@A2AAgent({ target: { finishes: ["answer-workflow-finish"] } })` names the ones it takes:
  the card check compares only those, each a finish the card lists (`[a2a.unknown-finish]`,
  `A2AContractError` with `rule: A2AContractRule.UnknownFinish`; at assembly already for a name no
  `@WorkflowFinish` could have, an empty list, a name twice or an agent with no `output`). A task
  that ends at another finish (its artifact's `metadata[skills-uri].finish`) fails the call with
  `A2AUnexpectedFinishError` (`a2a.unexpected-finish`: `agent`, `finish`, `finishes`, `taskId`)
  before its output is read — a step's side path takes it, `.onError(A2AUnexpectedFinishError, …)`;
  an answer that names no finish (a foreign agent's) is read as before. `agboss describe` prints
  `· finishes: …` on the agent's line, `--json` the import's `target.finishes`.
- **Origins.** Every interface the card names must be on the `url`'s origin or one of
  `allowedOrigins` (`["https://rpc.billing.example"]`), else `A2AOriginError`
  (`a2a.origin-refused`): no request goes elsewhere — so the client's headers (`headers`,
  `getHeaders()`) never leave its origins — and a redirect off them is refused, never followed.
- **The message.** `execute(input)` sends one `data` part (`application/json`; one `text` part for
  `WorkflowStartTextDto`) and names the skill in `message.metadata["https://agboss.dev/a2a/skills/v1"]
  = { skill }`; `send(message)` takes a text, `{ data }` or the parts; `reply(taskId, answer)`
  continues a task that waits for input; `getTask(taskId)`, `cancel(taskId)`, `agentCard()`.
- **The accept** is one `SendMessage` with `returnImmediately`, through
  [Outbound calls](Several-instances) inside an execution (`a2a.<agent>[.reply][.<call.key>]`): its
  `messageId` is derived from the step's key, the same on every attempt. A send of unknown outcome
  (no answer, a 5xx, `-32603`) is reconciled, never resent blindly:

  | Peer | What a send of unknown outcome becomes |
  | --- | --- |
  | AGBoss (its card's mesh extension declares `params.idempotencyRetention`) | sent again with the same `messageId` — the agent returns the same task — within that retention (`NotSentTrust.KeyReplay`); past it `OutboundCallUnreconciledError` |
  | foreign, a reply to a known task | `GetTask`: the task no longer waits for input → the reply arrived; else unknown |
  | foreign, a new message | `OutboundCallUnreconciledError` (`foreign A2A peer`): nothing is sent again |

  The peer's trust is recorded with the intent: a card that changed since (a foreign peer now
  declaring a retention) is unknown, never a resend. A foreign peer's reply counts as arrived only
  when `GetTask`'s history holds its `messageId`. A send certainly did nothing only for an allowlist
  of codes that come before the agent acts (`-32700`, `-32600`, `-32601`, `-32602`, `-32001`,
  `-32004`, `-32005`, `-32008`, `-32009`, a 4xx but 408 / 429) or when it never left (a failing
  `getHeaders()`); anything else is of unknown outcome. Two calls of one step with different
  messages need their own `call.key` (`[a2a.repeated-call]`; 1–40 of `[A-Za-z0-9._-]`). A step of no
  composed application (a unit runner's) has nothing to record into: `[a2a.outside-application]`,
  nothing sent — mock the client there.
- **Waiting** is a pure read, safe after any crash: `SubscribeToTask` when the card streams (a
  dropped stream is opened again, then polling), else `GetTask` polled on the `Clock` (250 ms
  doubling to 5 s). A task that works — an out-of-band pause included — is waited for up to the
  execution's deadline or `call.timeout`: then a best-effort `CancelTask` and `A2ACallDeadlineError`
  (`cancel: A2ACancelOutcome` — `canceled`, `not-canceled`, `refused`, `no-answer`). Every event and
  read must be of the waited task (another id, a message in its stream: `A2ARemoteCallError`); a
  read that fails transiently (no answer, a 5xx, 408, 429, `-32603`) is tried again, by stream or
  poll alike, any other ends the wait; the caller's `onEvent` failing ends it with its own error. The call's `signal` ends the wait with its reason and cancels nothing.
- **Outcomes.** COMPLETED → the output, read from the artifact an AGBoss finish marks
  (`metadata[skills-uri].finish`) when the task has one, else from every artifact in order (none readable: `A2ARemoteCallError`, was `A2ARemoteError`);
  FAILED / REJECTED → `A2ATaskFailedError` (an AGBoss peer's `limit.mesh-loop` / `limit.hops` → the
  same `MeshLoopDetectedError` / `HopsLimitExceededError`); CANCELED → `A2ATaskCanceledError`;
  INPUT_REQUIRED → `A2ATaskInterruptedError` from `execute` (a remote pause is not a local one yet),
  the task from `send`; a JSON-RPC error → `A2AProtocolError` (`rpcCode`); a refused caller →
  `A2ACallerRejectedError`. Only codes: an agent's message, status text or body is never kept.
- **The mesh** rides as the extension `https://agboss.dev/a2a/mesh/v1`: `mesh: A2AMesh.Required`
  (the default with a `target.application`; a card without the extension is
  `A2AMeshUnsupportedError`, nothing sent) or `A2AMesh.IfSupported` (`result.peer.mesh: false`). The
  envelope ([§6](#6-the-mesh--call-chains-hops-and-loops-398)) goes in
  `message.metadata[uri].envelope` with `A2A-Extensions` and `traceparent`, its `bodyHash` the
  message's canonical JSON without that entry (`meshBodyHashOf`); it is signed only with an
  `audience` — the target application — else it is an unsigned claim. A loop (the target's
  application and skill already in the chain) is refused before sending; under `Required` a step
  with no envelope to send is refused too, and `result.peer.mesh` is `true` only once one rode and
  the agent echoed the extension in its answer's `A2A-Extensions` (#810, spec §4.6) — an agent that
  does not is called without the mesh, said in the tool call's record (`remote: { application,
  executionId: <task id>, mesh: false }`) and in `agboss describe` (`a2a agents`: `mesh: required` /
  `mesh: not guaranteed (foreign peer)`). The `price` is charged to the step (`a2a:<application>`)
  when the call is accepted — a call that later runs out of time or fails there is charged too; a
  call the agent refused before anything ran (its task `REJECTED` at the accept: a mesh loop, a
  chain past its `maxMeshHops`) is charged nothing, its price neither, on any pass, a takeover's
  replay of the accept too (#849, as in 0.1.0), said in the tool call's record (`remote: {
  application, executionId, refused: true }`). Only an AGBoss agent the mesh rode to refuses so:
  a `REJECTED` task with a mesh limit; any other `REJECTED` answer is charged as accepted. The
  refusal is the agent's word, so it is fail-closed: such a task is never waited on and none of its
  output is used; the client reads it once more (`GetTask`) — still refused, the limit is thrown;
  anything else (working, completed) contradicts it, so the price is charged and the call fails
  with `A2AProtocolError` — and a verified run
  report's spend above it at the end (the report must name the call's task); a completed task with
  no run report the caller verifies — an untrusted caller, a peer that signs nothing, another body's
  or task's report — is charged the price alone and said so in the tool call's record (`remote: {
  application, executionId, report: false }`, #844). **Exactly once across
  passes (#810):** both charges are made on every pass that reaches the accept — a takeover that
  replays the accept an earlier pass recorded too — under the call's own ledger identity
  (`UsageRecord.ledgerKey`: `a2a:<messageId>:price`, dated by the accept; `a2a:<messageId>:report`,
  dated by the report clamped into the caller's own window — from its stored accept to its `now`, never the peer's date alone): the ledger adds each once, whichever pass writes it first. A call priced 1
  whose peer reports 3 costs 3 — never 1 (the excess lost on a replay), 4 or 6 — when its holder
  dies while it waits, after it settled but before its step was durable, or while a frozen holder
  settles beside the new one (`tests/a2a/mesh/a2a-mesh-takeover.test.ts`).

## 5. Testing — the `a2aServer` fixture

`testWith`'s `a2aServer({ expose, callerResolver, base? })` serves the test's `app` through
`a2aHttpListener` on `127.0.0.1:0` and returns `{ url }` (`A2ATestServer`); the loopback is open
for it (no `allowNetwork` needed) and the server is closed at the test's end. The resolver comes
from the test app's container, so `override(ApiKeyDirectory, FixedApiKeyDirectory)` and `mockOf`
reach it.

```ts no-check: ShopApplication and its workflow are not written out on this page
@Injectable()
class FixedApiKeyDirectory extends ApiKeyDirectory {
  override grantOf(apiKey: string): Promise<ApiKeyGrant | undefined> {
    const known = apiKey === "key-acme";
    return Promise.resolve(known ? { clientId: "c-1", tenantId: "acme", canAnswerPauses: true } : undefined);
  }
}

const test = testWith(ShopApplication, { overrides: [override(ApiKeyDirectory, FixedApiKeyDirectory)] });

test("an unknown key is 401 and never runs", async ({ a2aServer }) => {
  const { url } = await a2aServer({ expose: ShopA2AExpose, callerResolver: ShopA2aCallerResolver });

  // any A2A v1.0 client calls the listener; a plain JSON-RPC SendMessage is the smallest one
  const sent = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": "1.0",
      authorization: "Bearer key-unknown",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "hi" }] } },
    }),
  });

  expect(sent.status).toBe(401);
  expect(await sent.json()).toMatchObject({ code: "a2a.caller-unauthenticated" });
});
```

`app.resolve(Class)` of `testWith`'s `app` works once the app is built (`await app.ready()`, or
after an `execute`) — before that it fails with `test.app-not-ready`.

## 6. The mesh — call chains, hops and loops (#398)

Applications calling each other over A2A (and MCP, [MCP](Mcp#4-calls-between-agboss-applications--_meta-398))
form a mesh. Every call made **inside an execution** — a tool's or an action's — sends, with no code
of yours, the **mesh envelope**: over A2A in `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope`
(the [mesh extension](A2A-Mesh-Extension), its `bodyHash` the message's canonical JSON without that
entry, `meshBodyHashOf`; the task is deduplicated by its `messageId` (§2), never by an envelope's
key), over MCP in `_meta["agboss.dev/mesh"]`. Both are a JWS — unsecured (`alg: "none"`) or signed
(`EdDSA`, [below](#trusted-peers--signed-envelopes-398-pr-2)): `schema`, `issuer`, `origin`,
`callChain`. A W3C `traceparent` (the caller's trace id continued, else one of its root execution)
rides beside it. The A2A listener's side, in order, is [§6.1](#61-the-mesh-on-the-a2a-v10-listener-810).

`origin` (`MeshOrigin`) names the calling `rootExecutionId`, `executionId`, `parentExecutionId?`,
`workflow { name, version }` and `step { component, idempotencyKey }` (`MeshOriginStep`; a tool
call's key ends with its call id). `callChain` lists the applications the request passed through
(`MeshHop`: a `MeshEntry` — `application`, `start` — and the root `executionId` of that hop), the
caller's own hop last. Ids only: no `ownerId`, no `tenantId`, no input values. Outside an execution
(a script's `new A2AClient(…)`) nothing is sent.

**On the receiver the envelope is a claim** — unless a trusted peer signed it
([below](#trusted-peers--signed-envelopes-398-pr-2)). The listener reads it into
`A2ACallerRequest.envelope` for the resolver: never the tenant. An envelope it cannot read (not an unsecured JWS of `schema: 1`, too long, a hop without
its id) is ignored: the request runs as one without — stripping it is no different. What
the receiver applies anyway (a caller can only make its own request fail with it):

| The chain the request arrives with                             | The answer (MCP; over A2A a `REJECTED` task, §6.1)                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| already lists this application **and** this start              | `409 { "code": "limit.mesh-loop", "error", "details": { "entry", "chain" } }`    |
| already lists `@Application({ maxMeshHops })` applications (8) | `409 { "code": "limit.hops", "error", "details": { …, "maxMeshHops", "hops" } }` |
| anything else                                                  | the run — its own calls carry the chain on, its hop added                        |

A refusal runs nothing (no observer event, no record), like a refused caller. A loop is the same
`(application, start)` twice — at any depth; another start of the same application is not one.
`maxMeshHops` counts applications (`hops` = the chain + the receiver); anything but a whole number
from 1 is `[limits.max-mesh-hops-invalid]`. A resume is not checked: its execution has its chain.

**On the caller** a `409` (MCP), or over A2A the `REJECTED` task's code and details ([§4](#4-the-client-side--a2a-v10-809)), is rethrown as `MeshLoopDetectedError` (`limit.mesh-loop`:
`entry`, `chain`) or `HopsLimitExceededError` (`limit.hops`: `entry`, `chain`, `maxMeshHops`,
`hops`) — both `LimitExceededError`s. `execute` does the same for a remote run that another hop's
limit stopped: a failed task carries the error's `code`, and for these two limits its `details`. A tool that meets one **fails its step** with it — the model never reads it (a retry
would loop again) — so a whole chain `A → B → A` fails at every hop, deterministically; take it on
the path (its side path leads to actions and finishes only, as for every limit):

<!-- snippet-context
import { Agent, MeshLoopDetectedError, Workflow, WorkflowFinish, WorkflowStart, start, toFinish } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
@Agent({ name: "orders-agent", description: "Orders", prompt: "Answer.", model: "moonshotai/kimi-k2.6" })
export class OrdersAgent {}
@WorkflowStart({ name: "orders-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class OrdersWorkflowStart {}
@WorkflowFinish({ name: "orders-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class OrdersWorkflowFinish {}
@WorkflowFinish({ name: "looped-workflow-finish", description: "Handed back", output: WorkflowStartTextDto })
export class LoopedWorkflowFinish {}
-->

```ts
@Workflow({
  name: "orders-workflow",
  version: "1.0.0",
  flow: [
    start(OrdersWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrdersAgent) // its tool calls the billing application over A2A
      .onError(
        MeshLoopDetectedError, // billing called back into orders-workflow-start
        toFinish(LoopedWorkflowFinish),
      )
      .toFinish(OrdersWorkflowFinish),
  ],
})
export class OrdersWorkflow {}
```

### Trusted peers — signed envelopes (#398 PR 2)

An application that names its keys in `@Application({ mesh })` (`MeshOptions`, each peer a
`MeshPeer`) signs every envelope it sends and
every run report it answers with (JWS `EdDSA`, Ed25519); its `peers` are the applications whose
signatures it checks. Keys are PEM in environment fields, named by field as a `@ModelProvider`'s
`apiKey` is: the private key a `Secret` field (PKCS #8, `-----BEGIN PRIVATE KEY-----`), a peer's
public key a plain text field (SPKI, `-----BEGIN PUBLIC KEY-----`) — it is public.

<!-- snippet-context
import { Application, type Secret } from "@agboss/core";
import { minutes } from "@agboss/core/units";
export class BillingWorkflow {} // a @Workflow of its own
-->

```ts
// environments/billing.environment.ts — the contract; each environment sets
// meshSigningKey: secret("MESH_SIGNING_KEY"), ordersPublicKey: env("ORDERS_PUBLIC_KEY")
export class BillingEnvironment {
  meshSigningKey!: Secret;
  ordersPublicKey!: string;
}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: BillingEnvironment,
  workflows: [BillingWorkflow],
  mesh: {
    signingKey: "meshSigningKey",
    peers: [{ application: "orders-application", verifyKey: "ordersPublicKey" }],
  },
  retention: { meshAnswers: minutes(30) }, // how long a trusted request's answer is kept
})
export class BillingApplication {}
```

At assembly a key field the contract lacks is `[mesh.signing-key-missing]` /
`[mesh.unknown-peer-key]`, a peer listed twice `[mesh.duplicate-peer]`; at start a field that holds
no Ed25519 key of its kind fails it — `[mesh.invalid-key] meshSigningKey holds no Ed25519 private
key (PKCS #8 PEM) (…)`, never the value. `maxMeshHops` stays a setting of its own.

A signed envelope adds `issuedAt`, `expiresIn` (`PT60S`), `bodyHash` (`sha256:<hex>` of the body),
and the caller's claims `budget { remaining, currency: "USD" }` (what its execution has left) and
`deadline { remaining }` (ISO 8601 duration: the calling tool's timeout or its execution's
deadline, the earlier). `origin.step.tool` names the calling tool.

**A request is trusted only when both hold:** the caller resolver names its `peer` —
`A2ACallerResolution.resolved({ …, peer: "orders-application" })`, what your transport proved
(mTLS, a token) — and the envelope carries that peer's valid signature. The order of a `POST`:

1. the envelope read; a signed one of a known issuer verified — its signature, then `issuedAt` +
   `expiresIn` on the application's `Clock` (30 s of tolerance): a bad one is `401`
   `{ "code": "mesh.signature-invalid" | "mesh.envelope-expired" }`, before the resolver;
2. the caller resolved (above), then the chain (loops, hops);
3. the body: a trusted envelope's `bodyHash` must be its hash — else `401 mesh.body-mismatch`;
4. over MCP a trusted call is deduplicated by `(tenant, peer, _meta.callId)` in the application's
   `MeshRequestRepository` ([Several instances](Several-instances);
   [MCP](Mcp#4-calls-between-agboss-applications--_meta-398)): a repeat gets the kept answer
   without running, one while the first still runs an error result `mesh.request-in-progress`; a
   run that did not answer is forgotten. Over A2A every caller, signed or not, is deduplicated by
   `messageId` in the task and message stores (§2);
5. the run.

A peer's public key comes from `mesh.peers`.

**Signing as a peer in a test (#521):** for an MCP call `signedMeshEnvelope` (`@agboss/core/testing`)
gives the `_meta["agboss.dev/mesh"]` value an application with `mesh.signingKey` sends — the
framework's own encoder, so a store's deduplication test or a receiver's limits speak the real wire
format. A key that is not an Ed25519 private key is a `TestSetupError`, never an unsigned envelope.
An A2A call is signed by the `A2AClient` of a test application that has a `mesh.signingKey`: its
envelope is bound to the very message it sends, and the listener trusts it exactly as a real
client's request.

What a trusted request gets — an untrusted one none of it:

| From the caller                      | The receiver                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `budget.remaining`                   | one more execution budget, `caller-budget` — it only lowers its own: `BudgetExceededError` (`"limited"`)      |
| `deadline.remaining`                 | the execution's deadline, the smaller of it and its own: `DeadlineExceededError` (`limit.deadline`)           |
| `origin` and the chain's length      | `executionContext.origin`, the execution record's `origin` and every observer event's — its resumes' and recoveries' too (`ExecutionOrigin`) |
| its body and idempotency key         | the body checked, the request deduplicated                                                                    |

`ExecutionOrigin` is the caller's `MeshOrigin` plus `application` (the peer) and `hops` (the
applications before this one). Its answer carries the run report (A2A: `task.metadata[uri].report`; MCP:
`_meta["agboss.dev/report"]`): a run report (`MeshRunReport`: `issuer`, `executionId`,
`spend`, `bodyHash`, `issuedAt`) the receiver signs. The caller verifies it with its own
`mesh.peers` key of the issuer and its request's `bodyHash`, then records the reported spend in the
calling tool's spend (`a2a:<issuer>` as its model, `byModel`) and the remote execution in
`ToolCallRecord.remote` (`ToolCallRemote`: `application`, `executionId`). An unsigned or unverified
report is ignored: a caller never pays what an untrusted peer says.

**The deadline** is yours too: `app.execute(Start, input, { deadline: seconds(30) })` — fixed on the
`Clock` when the execution starts, kept in its state (a pause counts), checked where the budgets
are: before every agent and router step and every model call (a call in flight is not cut short).
`DeadlineExceededError` (`limit.deadline`: `deadline`, `deadlineAt`) is a `LimitExceededError`.

The envelope's `audience` and a contract price come with declared contracts ([§7](#7-declared-contracts-398-pr-3)).

### 6.1 The mesh on the A2A v1.0 listener (#810)

`a2aHttpListener` reads the envelope of a `SendMessage` / `SendStreamingMessage` from the message
**as the SDK's transport decodes it** — what is checked is what runs — once its `A2A-Version` and
its operation are read, **before the caller resolver and before anything runs**:

1. **The audience, first**: an envelope addressed to another application is `401 { "code":
   "mesh.audience-mismatch" }`, a signed one addressed to none `401 mesh.audience-missing` — against
   the application's own `@Application({ name })`, whoever signed it and whatever its `mesh`
   settings (with none at all it still fails closed), before any signature is looked at.
2. **A known issuer's signature** (`mesh.peers`): `401 mesh.signature-invalid`; its replay window
   (`issuedAt` + `expiresIn`, the `Clock`): `401 mesh.envelope-expired`; its `bodyHash` against
   `meshBodyHashOf` of the decoded message: `401 mesh.body-mismatch` — an envelope cannot be moved
   to another message. A signed envelope of an unknown issuer is an unsigned claim.
3. The caller resolved; the request is **trusted** when the resolver's `peer` is the envelope's
   verified issuer.
4. **The chain**, on every envelope, trusted or not: one that already passed through this skill, or
   is as long as `maxMeshHops`, is accepted as a **`REJECTED` task** — `status.message.metadata[uri]
   = { code: "limit.mesh-loop" | "limit.hops", details: { entry, chain, maxMeshHops? } }`, nothing
   started, a resend of its `messageId` gets it again — which the AGBoss client rebuilds into the
   same `MeshLoopDetectedError` / `HopsLimitExceededError`.
5. The execution runs with the envelope's chain, and a trusted caller's origin
   (`executionContext.origin`), budget (`caller-budget` — a step's spend past it fails the remote
   execution with `limit.budget`) and deadline. The card declares the extension
   (`params.idempotencyRetention` = `@Application({ retention: { a2aTasks } })`, how long a
   `messageId` is deduplicated) and the answer echoes it in `A2A-Extensions` when it was asked.
6. **The run report**: a trusted task keeps its first message's `bodyHash`
   (`A2ATaskRecord.meshBodyHash`) and, once `COMPLETED`, carries the report the application signs
   with `mesh.signingKey` in `task.metadata[uri].report` — `GetTask`, `ListTasks`, and the stream's
   last status update — over what its execution spent (`A2ATaskStatus.spentUsd`: its end event's,
   or — when that event was lost and read repair completed the task — the spend its tree's last
   checkpoint keeps, #844: a missed end never leaves its caller charged the price alone).

An `@A2AAgent`'s remote call from an action passes the action's budget down as a tool's does.

## 7. Declared contracts (#398 PR 3)

Both sides of a call are declared, so `agboss describe --json` lists them and a federation check
can compare applications without running them.

**The caller** — an `@A2AAgent` names what it calls, sends, gets back and costs:

<!-- snippet-context
import { Tool, type ToolHandler } from "@agboss/core";
import { Text } from "@agboss/core/dto";
export class InvoiceQuestionDto {
  @Text({ prompt: "the question about an invoice" })
  question!: string;
}
export class InvoiceAnswerDto {
  @Text()
  answer!: string;
}
-->

```ts
import { A2AAgent, A2AClient } from "@agboss/core/a2a";
import { usd } from "@agboss/core/units";

// a2a/billing-desk.a2a-agent.ts
@A2AAgent({
  name: "billing-desk-a2a-agent",
  url: "https://billing.example/a2a",
  target: { application: "billing-application", skill: "billing-workflow-start" },
  input: InvoiceQuestionDto, // the target skill's input, validated before it is sent
  output: InvoiceAnswerDto, // its finish's output, validated when it comes
  price: usd(0.05), // one call's price by contract
})
export class BillingDeskA2AAgent extends A2AClient<InvoiceQuestionDto, InvoiceAnswerDto> {}

@Tool({
  name: "ask-billing-tool",
  description: "Asks the billing desk",
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
  deps: [BillingDeskA2AAgent],
})
export class AskBillingTool implements ToolHandler<InvoiceQuestionDto, InvoiceAnswerDto> {
  constructor(private readonly billingDeskA2AAgent: BillingDeskA2AAgent) {}

  run(question: InvoiceQuestionDto): Promise<InvoiceAnswerDto> {
    return this.billingDeskA2AAgent.execute(question); // typed by the contract
  }
}
```

- `execute(input, call?)` replaces `execute(input, OutputDto, call?)` (breaking, [Changelog](Changelog)).
  A client built by hand states the contract: `new A2AClient({ url, contract: { application?, skill?,
  input, output } })` (`A2AClientContract`, #809); without its DTOs, `execute` throws
  `[a2a.no-contract]` (`send` needs none).
- Names: `-a2a-agent` on a `…A2AAgent` class (`[name.kind-suffix]`, both checked, like `@Application`
  and `@Budget`); `target` is optional (#809: a foreign agent has no application) and names a
  `skill` (was `start`). Files: `a2a/<name>.a2a-agent.ts`.
- **The price**: the calling tool's spend records the larger of `price` and the spend a
  trusted peer's signed run report gives — the price alone without one — as `a2a:<application>`;
  nothing for a call the agent `REJECTED` before anything ran (#849).
- **The audience**: the envelope's `audience` is `target.application` (over MCP an `@McpServer({
  target: { application, expose } })`'s). A receiver of another name refuses it, signed or not,
  before its resolver — `401 { "code": "mesh.audience-mismatch" }` (MCP: an error result with that
  code): a call meant for one application is never run by another it was forwarded to. A signed
  envelope must name one (#809): a sender signs only with an audience, and a signed envelope without
  one is refused as `mesh.audience-missing` before its signature is verified (the receivers' shared
  check; over MCP an error result with that code, on the A2A listener `401`, #810) — else any
  receiver could replay it to another application as its issuer's signed word.

**The receiver** — an `@A2AExpose` (mirrors `@McpExpose`) names what it serves, listed with its
`@McpExpose`s in `@Application({ exposes })`:

<!-- snippet-context
import { Application, EmptyEnvironment, WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
@WorkflowStart({ name: "billing-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class BillingWorkflowStart {}
export class BillingWorkflow {} // a @Workflow of its own
-->

```ts
import { A2AExpose } from "@agboss/core/a2a";

// a2a/billing.a2a-expose.ts
@A2AExpose({
  name: "billing-a2a-expose",
  version: "1.0.0",
  description: "Answers billing questions", // the Agent Card's description (#808)
  exports: [BillingWorkflowStart],
})
export class BillingA2AExpose {}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BillingWorkflow],
  exposes: [BillingA2AExpose],
})
export class BillingApplication {}
```

- `[name.kind-suffix]` (`-a2a-expose`, a `…A2AExpose` class), `[application.expose-unknown-start]`
  (an export that is no start of the application's workflows), `[application.not-an-expose]`,
  `[application.duplicate-expose]` at assembly.
- With one export a message may leave its skill out; with several it names one in
  `metadata["https://agboss.dev/a2a/skills/v1"].skill`, or the expose sets a `defaultSkill`.
- `[a2a.expose-description-required]` (a blank `description`), and two warnings, errors under
  `--strict`: `[a2a.skill-tags]` (a skill with no `skills: { [start]: { tags } }`; the card says the
  application's name) and `[a2a.unpriced-foreign-peer]` (an `@A2AAgent` without `target.application`
  and without `price`: a foreign peer's spend is invisible to the budgets) (#812).

**`describe --json`** — `application.contracts`:

```json
{
  "exports": [
    {
      "kind": "a2a", "expose": "billing-a2a-expose", "version": "1.0.0",
      "skill": "billing-workflow-start", "workflow": "billing-workflow", "reply": "task", "cardFileFields": "extension",
      "input": { "dto": "InvoiceQuestionDto", "schemaHash": "600a…" },
      "outputs": [{ "finish": "billing-answer-workflow-finish", "dto": "InvoiceAnswerDto", "schemaHash": "6b22…" }]
    },
    { "kind": "mcp", "expose": "billing-mcp-expose", "version": "1.0.0", "tool": "invoice-status-tool", "input": { "dto": "InvoiceQueryDto", "schemaHash": "380d…" } }
  ],
  "imports": [
    {
      "kind": "a2a", "client": "billing-desk-a2a-agent", "foreign": false,
      "target": { "application": "billing-application", "skill": "billing-workflow-start" },
      "usedBy": [{ "workflow": "orders-workflow", "tool": "ask-billing-tool" }],
      "input": { "dto": "InvoiceQuestionDto", "schemaHash": "600a…" },
      "output": { "dto": "InvoiceAnswerDto", "schemaHash": "6b22…" },
      "price": 0.05
    },
    { "kind": "a2a", "client": "weather-a2a-agent", "foreign": true, "target": null, "usedBy": [], "input": null, "output": null, "price": null },
    { "kind": "mcp", "server": "kb", "tool": "search", "target": null, "usedBy": [{ "workflow": "orders-workflow", "tool": "search-kb-tool" }], "input": { "…": "…" }, "output": { "…": "…" } }
  ],
  "schemas": { "InvoiceQuestionDto": { "schemaHash": "600a…", "jsonSchema": {} } }
}
```

An `@McpServer` without a `target` (a third-party server) is listed with `target: null`. An
`@A2AAgent` without `target.application` (a foreign A2A agent, typed or not) is listed with
`foreign: true`, `target: null` and — untyped — `input` / `output` `null`; every other import has
`foreign: false`, and federation never compares a foreign one (§8). A snapshot saved by 0.1.0
(exports and targets named `start`, no `foreign`) is still read as skills (#812). A start's
input that is a map of fields, not one DTO, is `null` there (only its hash is in the workflow's
snapshot).

## 8. The federation check (#398 PR 4)

`agboss check --federation <snapshot…>` compares the application's declared contracts with its
neighbours' — each one's `agboss describe --json` output, saved as a file. It takes files and
folders of them (every `*.json` under a folder), reads only the disk (no network, no neighbour
running), and runs after the assembly like `--cassettes`:

```sh
npx agboss describe --json > ../snapshots/shop.json   # in each neighbour, on its release
npx agboss check --federation ../snapshots            # in this application, before shipping
```

Every consumed contract whose target application is among the snapshots (or is this application)
is checked against that application's exports — an `@A2AAgent`'s `target.application` and
`target.skill` (paired with the export's `skill`, the exported start's name), an `@McpServer`'s `target: { application, expose }` and its tools:

| Code | When |
| --- | --- |
| `[federation.missing-target]` | the target application exports no such skill (or no such tool under that expose); never for a foreign `@A2AAgent`, which is skipped |
| `[federation.incompatible-schema]` | the export's input does not accept every value the consumer may send, or the consumer's output does not accept every value one of the export's finishes may give — of those its `target.finishes` names, when it names some (#916) |
| `[federation.unknown-finish]` | the consumer's `target.finishes` names a finish the export's start does not have (#916) |
| `[federation.snapshot-schema]` | a file that is not an `agboss describe --json` output with `application.contracts` (or a path that does not exist) |
| `[federation.duplicate-application]` | two snapshots of one application |
| `[federation.version-not-bumped]` | the project's own earlier snapshot is among them, an `@A2AExpose` start's schema changed and its `version` did not — a warning, an error under `--strict` |

The comparison is **structural**, never by hash: an equal `schemaHash` is only the fast path. Each
difference is one reason, named by its field path — a field now required that the sender may leave
out or does not send, a type it may send that is not accepted (an `integer` is a `number`), an enum
value, a tighter bound or a pattern, a field no longer accepted (`additionalProperties: false`),
list items and unions, `$ref`s into `$defs`. Each problem names its **blast radius** — the
consumer's workflows and tools that use the contract (`usedBy`):

```text
snapshots/shop.json federation.incompatible-schema shop-application › billing-desk-a2a-agent → billing-application › billing-workflow-start: input StrictBillingQuestionDto: field "invoiceNumber" is now required; the sender does not send it — affects shop-application › quote-workflow (ask-billing-tool)
```

A problem is exit 3, like every `check` problem; `--json` carries each one with its `blastRadius`
(`{ application, workflow, tool }[]`). Snapshot paths without `--federation`, or the flag without
any, are a usage error (exit 2). The comparison is `checkFederation` in `@agboss/core/internal`.

**Standalone executable proof:** [`06-enterprise-agent-mesh`](https://github.com/agbossjs/agboss-examples/tree/main/06-enterprise-agent-mesh) (`apps/1-order-gateway`, `apps/2-billing-a2a`, `apps/3-catalog-mcp`, and `federation/`) in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) — see [Example](Example#standalone-verified-applications-agbossjsagboss-examples).
