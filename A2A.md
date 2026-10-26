# A2A (agent-to-agent)

`@agboss/core/a2a` works both ways:

- **Calling another application** — a declared contract (#398 PR 3, [§7](#7-declared-contracts-398-pr-3)):
  a `…A2AAgent` class that `extends A2AClient<In, Out>` with `@A2AAgent({ name, url, target, input,
  output, price?, deps })`, listed in `providers` and injected into a `@Tool` or an `@Action`
  ([Components](Components)); `execute(input, call)` sends the input and returns the remote output,
  both validated by the contract's DTOs, `send(input, call)` the response whatever its status.
- **Serving a workflow** — an `@A2AExpose` listed in `@Application({ exposes })`, served by
  `a2aHttpListener(app, { expose, callerResolver, base? })` (#387, #398): `POST <base>/execute`
  `{ input, start?, threadId? }`, `POST <base>/resume` `{ pauseId, decision }` and `POST
  <base>/cancel` `{ threadId }`, answered as JSON or — with `Accept: text/event-stream` — progress
  events and one `finish` event. This page is mostly about this side.

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
  A2ARoute,
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
    if (request.route === A2ARoute.Resume && !grant.canAnswerPauses) {
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    }
    return A2ACallerResolution.resolved({
      tenant: { tenantId: grant.tenantId }, // the declared TenantContext's values: typed, required
      ownerId: grant.clientId, // the thread's owner — also who may answer its pauses
    });
  }
}
```

- `resolveCaller({ route, http })` gets the route (`A2ARoute.Execute` / `Resume` / `Cancel`) and the raw
  `IncomingMessage` — its headers and its socket (a client certificate for mTLS) — **never its
  body**: it runs before the body is read and before any header is written.
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
    base: "/a2a",
  }),
).listen(8080);
```

The listener takes the resolver's instance from the application's container when it is built: a
class neither the application nor any of its workflows lists stops it there —
`[a2a.caller-resolver-not-listed] ShopA2aCallerResolver is not listed …` — and an expose the
application does not list too: `[application.expose-unlisted]`. `app` is an `A2AApp`
(`execute`, `resume`, `cancel`, `resolve` of `App`): `createApp`'s app and `testWith`'s `app` both
fit.

Per `POST`: the route is matched first (`404` otherwise, unchanged), then the caller is resolved:

| The resolver returns                                         | The caller gets                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `resolved({ tenant, ownerId, execution })`                   | the body parsed (`400` when invalid; `400 a2a.unknown-start` for a `start` it does not export, or none with several), the run for that tenant and owner, its response |
| `unauthenticated({ reason, challenge })`                     | `401`, `WWW-Authenticate: <challenge>`, `{ "code": "a2a.caller-unauthenticated", "error": reason }` |
| `forbidden({ reason })`                                      | `403`, `{ "code": "a2a.caller-forbidden", "error": reason }`                                    |
| it throws (or answers anything else)                         | `500`, `{ "code": "a2a.caller-resolution-failed", "error": "the caller could not be resolved" }` |

- A refused request **runs nothing**: no `onExecutionStart`, no `onExecutionRejected`, no thread,
  no record, no model call — and never as the default tenant. Its body is discarded unread.
- The host's `reason` goes on the wire (its own wording); an exception's text never does.
- A streaming caller gets the real status too: no event-stream header is written before the
  resolver answered.
- An admitted caller's values are checked by the application as for `app.execute` — an invalid one
  is `dto.invalid`, answered `status: "failed"`. A thread id is the caller's tenant's: two tenants'
  `ticket-7` are two threads, and one tenant's exhausted budget limits only it (`"limited"`).
- A caller that disconnects cancels its run (the listener aborts its `signal`).

On the wire the thread is `threadId` (request and response, #387 — it was `thread`).

## 3. A route of your own — `A2AAdapter`

In your own HTTP framework, `new A2AAdapter(app)` maps calls to responses (a failure is a status:
`failed`, `limited`, `cancelled`), with the caller's values from your own authentication:

<!-- snippet-context
import type { App } from "@agboss/core";
import { A2AAdapter } from "@agboss/core/a2a";
declare const app: App;
declare const SupportWorkflowStart: new () => object;
-->

```ts
const adapter = new A2AAdapter(app);
const caller = { tenant: { tenantId: "acme" }, ownerId: "client-acme" };

const response = await adapter.execute(
  SupportWorkflowStart,
  { input: { text: "Where is order 7?" }, threadId: "ticket-7" },
  undefined, // onEvent: progress events
  caller,
);
await adapter.cancel("ticket-7", caller); // only acme's ticket-7; another tenant's is untouched
console.log(response.status, response.threadId);
```

## 4. The client side

`A2AClient.send(input, { threadId, signal, onEvent })` posts `{ input, start?, threadId? }` (`start`
is the contract's `target.start`). A refused envelope — a `401` with a `mesh.*` code — is an `Error`
whose message starts with its code (`[mesh.audience-mismatch] …`). A server that
refuses the caller — a `401` / `403` carrying an `a2a.caller-*` code — throws
`A2ACallerRejectedError` (`code` `a2a.caller-rejected`, like every `AGBossError`; `httpStatus`; the
server's code in `wireCode`, `a2a.caller-unauthenticated` / `a2a.caller-forbidden`, #457; the
server's reason in its message); any other failed request is a plain `Error`; a remote run that did not finish is
`A2ARemoteError` from `execute`.

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

  const sent = new A2AClient({ url, headers: { authorization: "Bearer key-unknown" } }).send({ text: "hi" });

  await expect(sent).rejects.toFailWith(A2ACallerRejectedError, {
    httpStatus: 401,
    wireCode: "a2a.caller-unauthenticated",
  });
});
```

`app.resolve(Class)` of `testWith`'s `app` works once the app is built (`await app.ready()`, or
after an `execute`) — before that it fails with `test.app-not-ready`.

## 6. The mesh — call chains, hops and loops (#398)

Applications calling each other over A2A (and MCP, [MCP](Mcp#4-calls-between-agboss-applications--_meta-398))
form a mesh. Every call an `A2AClient` makes **inside an execution** — a tool's or an action's — sends,
with no code of yours:

| Header        | What it is                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agboss-mesh` | the `MeshEnvelope`, a JWS — unsecured (`alg: "none"`) or signed (`EdDSA`, [below](#trusted-peers--signed-envelopes-398-pr-2)): `schema`, `issuer`, `origin`, `callChain` |
| `traceparent` | W3C trace context: the caller's trace id continued (its own request's `traceparent`), else one of its root execution   |

`origin` (`MeshOrigin`) names the calling `rootExecutionId`, `executionId`, `parentExecutionId?`,
`workflow { name, version }` and `step { component, idempotencyKey }` (`MeshOriginStep`; a tool
call's key ends with its call id). `callChain` lists the applications the request passed through
(`MeshHop`: a `MeshEntry` — `application`, `start` — and the root `executionId` of that hop), the
caller's own hop last. Ids only: no `ownerId`, no `tenantId`, no input values. Outside an execution
(a script's `new A2AClient(…)`) nothing is sent.

**On the receiver the envelope is a claim** — unless a trusted peer signed it
([below](#trusted-peers--signed-envelopes-398-pr-2)). The listener reads it into
`A2ACallerRequest.envelope` for the resolver: never the tenant. A header it cannot read (not an unsecured JWS of `schema: 1`, too long, a hop without
its id) is ignored: the request runs as one without — stripping the header is no different. What
the listener applies anyway, after the caller is resolved and before the body is read (a caller can
only make its own request fail with it):

| The chain the request arrives with                             | The answer                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| already lists this application **and** this start              | `409 { "code": "limit.mesh-loop", "error", "details": { "entry", "chain" } }`    |
| already lists `@Application({ maxMeshHops })` applications (8) | `409 { "code": "limit.hops", "error", "details": { …, "maxMeshHops", "hops" } }` |
| anything else                                                  | the run — its own calls carry the chain on, its hop added                        |

A refusal runs nothing (no observer event, no record), like a refused caller. A loop is the same
`(application, start)` twice — at any depth; another start of the same application is not one.
`maxMeshHops` counts applications (`hops` = the chain + the receiver); anything but a whole number
from 1 is `[limits.max-mesh-hops-invalid]`. A resume is not checked: its execution has its chain.

**On the caller** `A2AClient.send` rethrows a `409` as `MeshLoopDetectedError` (`limit.mesh-loop`:
`entry`, `chain`) or `HopsLimitExceededError` (`limit.hops`: `entry`, `chain`, `maxMeshHops`,
`hops`) — both `LimitExceededError`s. `execute` does the same for a remote run that another hop's
limit stopped: a failed response now carries the error's `code`, and for these two limits its
`details`. A tool that meets one **fails its step** with it — the model never reads it (a retry
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
    // idempotencyRetention: minutes(30) — how long a trusted request's answer is kept
  },
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
3. the body read: a trusted envelope's `bodyHash` must be its hash — else `401 mesh.body-mismatch`;
4. a trusted `POST /execute` deduplicated by `(tenant, peer, origin.step.idempotencyKey)` in the
   application's `MeshRequestRepository` ([Several instances](Several-instances); over MCP by
   `_meta.callId`, [MCP](Mcp#4-calls-between-agboss-applications--_meta-398)): a repeat gets the
   kept answer without running, one while the first still runs `409 mesh.request-in-progress`; a
   run that did not answer is forgotten;
5. the run.

A peer's public key comes from `mesh.peers`, or from the listener's `meshVerifier` — an
`@Injectable` `MeshVerifier` (`verifyKeyOf(issuer)` → PEM, or `undefined`) listed in `providers`
and asked first: `a2aHttpListener(app, { expose, callerResolver, meshVerifier })`.

What a trusted request gets — an untrusted one none of it:

| From the caller                      | The receiver                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `budget.remaining`                   | one more execution budget, `caller-budget` — it only lowers its own: `BudgetExceededError` (`"limited"`)      |
| `deadline.remaining`                 | the execution's deadline, the smaller of it and its own: `DeadlineExceededError` (`limit.deadline`)           |
| `origin` and the chain's length      | `executionContext.origin`, the execution record's `origin` and every observer event's — its resumes' and recoveries' too (`ExecutionOrigin`) |
| its body and idempotency key         | the body checked, the request deduplicated                                                                    |

`ExecutionOrigin` is the caller's `MeshOrigin` plus `application` (the peer) and `hops` (the
applications before this one). Its answer — the `A2AExecutionResponse` — carries `executionId`,
`spend { total, currency }` and `report`: a run report (`MeshRunReport`: `issuer`, `executionId`,
`spend`, `bodyHash`, `issuedAt`) the receiver signs. The caller verifies it with its own
`mesh.peers` key of the issuer and its request's `bodyHash`, then records the reported spend in the
calling tool's spend (`a2a:<issuer>` as its model, `byModel`) and the remote execution in
`ToolCallRecord.remote` (`ToolCallRemote`: `application`, `executionId`). An unsigned or unverified
report is ignored: a caller never pays what an untrusted peer says.

**The deadline** is yours too: `app.execute(Start, input, { deadline: seconds(30) })` — fixed on the
`Clock` when the execution starts, kept in its state (a pause counts), checked where the budgets
are: before every agent and router step and every model call (a call in flight is not cut short).
`DeadlineExceededError` (`limit.deadline`: `deadline`, `deadlineAt`) is a `LimitExceededError`.

**`POST <base>/cancel { threadId }`** cancels the running execution of the caller's thread or drops
its pause — the caller resolved first, its tenant's thread only (another tenant's `ticket-7` is
never touched): `{ threadId, status: "cancelled" }`, or `status: "failed"` with the code
(`run.unknown-thread`, …). `A2AClient.cancel(threadId)` calls it.

The envelope's `audience` and a contract price come with declared contracts ([§7](#7-declared-contracts-398-pr-3)).

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
  target: { application: "billing-application", start: "billing-workflow-start" },
  input: InvoiceQuestionDto, // the target start's input, validated before it is sent
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
  A client built by hand states the contract: `new A2AClient({ url, contract: { target, input,
  output } })` (`A2AContract`); without one, `execute` throws `[a2a.no-contract]` (`send` needs none).
- Names: `-a2a-agent` on a `…A2AAgent` class (`[name.kind-suffix]`, both checked, like `@Application`
  and `@Budget`); `target` is required (`[a2a.target-required]`). Files: `a2a/<name>.a2a-agent.ts`.
- **The price**: the calling tool's spend records the larger of `price` and the spend a
  trusted peer's signed run report gives — the price alone without one — as `a2a:<application>`.
- **The audience**: the envelope's `audience` is `target.application` (over MCP an `@McpServer({
  target: { application, expose } })`'s). A receiver of another name refuses it, signed or not,
  before its resolver — `401 { "code": "mesh.audience-mismatch" }` (MCP: an error result with that
  code): a call meant for one application is never run by another it was forwarded to.

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
@A2AExpose({ name: "billing-a2a-expose", version: "1.0.0", exports: [BillingWorkflowStart] })
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
- With one export a request may leave `start` out; with several it names one.

**`describe --json`** — `application.contracts`:

```json
{
  "exports": [
    {
      "kind": "a2a", "expose": "billing-a2a-expose", "version": "1.0.0",
      "start": "billing-workflow-start", "workflow": "billing-workflow",
      "input": { "dto": "InvoiceQuestionDto", "schemaHash": "600a…" },
      "outputs": [{ "finish": "billing-answer-workflow-finish", "dto": "InvoiceAnswerDto", "schemaHash": "6b22…" }]
    },
    { "kind": "mcp", "expose": "billing-mcp-expose", "version": "1.0.0", "tool": "invoice-status-tool", "input": { "dto": "InvoiceQueryDto", "schemaHash": "380d…" } }
  ],
  "imports": [
    {
      "kind": "a2a", "client": "billing-desk-a2a-agent",
      "target": { "application": "billing-application", "start": "billing-workflow-start" },
      "usedBy": [{ "workflow": "orders-workflow", "tool": "ask-billing-tool" }],
      "input": { "dto": "InvoiceQuestionDto", "schemaHash": "600a…" },
      "output": { "dto": "InvoiceAnswerDto", "schemaHash": "6b22…" },
      "price": 0.05
    },
    { "kind": "mcp", "server": "kb", "tool": "search", "target": null, "usedBy": [{ "workflow": "orders-workflow", "tool": "search-kb-tool" }], "input": { "…": "…" }, "output": { "…": "…" } }
  ],
  "schemas": { "InvoiceQuestionDto": { "schemaHash": "600a…", "jsonSchema": {} } }
}
```

An `@McpServer` without a `target` (a third-party server) is listed with `target: null`. A start's
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
`target.start`, an `@McpServer`'s `target: { application, expose }` and its tools:

| Code | When |
| --- | --- |
| `[federation.missing-target]` | the target application exports no such start (or no such tool under that expose) |
| `[federation.incompatible-schema]` | the export's input does not accept every value the consumer may send, or the consumer's output does not accept every value one of the export's finishes may give |
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
