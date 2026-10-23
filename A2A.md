# A2A (agent-to-agent)

`agboss/a2a` works both ways:

- **Calling another application** — a class that `extends A2AClient` with `@A2AAgent({ name, url,
  deps })`, listed in `providers` and injected into a `@Tool` or an `@Action`
  ([Components](Components)); `execute(input, OutputDto, call)` returns the remote output validated
  by the DTO, `send(input, call)` the response whatever its status.
- **Serving a workflow** — `a2aHttpListener(app, { start, callerResolver, base? })` (#387): `POST
  <base>/execute` `{ input, threadId? }` and `POST <base>/resume` `{ pauseId, decision }`, answered
  as JSON or — with `Accept: text/event-stream` — progress events and one `finish` event. This page
  is mostly about this side.

## 1. Who calls — the caller resolver

The framework never guesses a tenant from a request. The host says who calls, for every request,
with a **caller resolver**: an ordinary `@Injectable` that `implements A2ACallerResolver<typeof
Start>`, listed in `@Application({ providers })` or a `@Workflow({ providers })` and created by the
application's container like any service — its own services through `deps`, its environment, its
hooks and a test's `override(…)` apply; never `new`.

<!-- snippet-context
import { Injectable, WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
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
} from "agboss/a2a";

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

- `resolveCaller({ route, http })` gets the route (`A2ARoute.Execute` / `Resume`) and the raw
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
import { createApp } from "agboss";
import { a2aHttpListener } from "agboss/a2a";

const app = await createApp(ShopApplication, { env: "prod" });

createServer(
  a2aHttpListener(app, {
    start: SupportWorkflowStart,
    callerResolver: ShopA2aCallerResolver, // the class: its instance is the container's
    base: "/a2a",
  }),
).listen(8080);
```

The listener takes the resolver's instance from the application's container when it is built: a
class neither the application nor any of its workflows lists stops it there —
`[a2a.caller-resolver-not-listed] ShopA2aCallerResolver is not listed …`. `app` is an `A2AApp`
(`execute`, `resume`, `cancel`, `resolve` of `App`): `createApp`'s app and `testWith`'s `app` both
fit.

Per `POST`: the route is matched first (`404` otherwise, unchanged), then the caller is resolved:

| The resolver returns                                         | The caller gets                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `resolved({ tenant, ownerId, execution })`                   | the body parsed (`400` when invalid), the run for that tenant and owner, its response          |
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
import type { App } from "agboss";
import { A2AAdapter } from "agboss/a2a";
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

`A2AClient.send(input, { threadId, signal, onEvent })` posts `{ input, threadId? }`. A server that
refuses the caller — a `401` / `403` carrying an `a2a.caller-*` code — throws
`A2ACallerRejectedError` (`code` `a2a.caller-rejected` on the class; on the error its `httpStatus`
and the wire `code`, `a2a.caller-unauthenticated` / `a2a.caller-forbidden`, the server's reason in
its message); any other failed request is a plain `Error`; a remote run that did not finish is
`A2ARemoteError` from `execute`.

## 5. Testing — the `a2aServer` fixture

`testWith`'s `a2aServer({ start, callerResolver, base? })` serves the test's `app` through
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
  const { url } = await a2aServer({ start: SupportWorkflowStart, callerResolver: ShopA2aCallerResolver });

  const sent = new A2AClient({ url, headers: { authorization: "Bearer key-unknown" } }).send({ text: "hi" });

  await expect(sent).rejects.toFailWith(A2ACallerRejectedError, {
    httpStatus: 401,
    code: "a2a.caller-unauthenticated",
  });
});
```

`app.resolve(Class)` of `testWith`'s `app` works once the app is built (`await app.ready()`, or
after an `execute`) — before that it fails with `test.app-not-ready`.
