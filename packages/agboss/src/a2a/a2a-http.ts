import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Class } from "../components/injection.js";
import { withInboundMesh, type InboundMesh } from "../mesh/inbound-mesh.js";
import type { MeshEnvelope } from "../mesh/mesh-envelope.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../mesh/mesh-verification.js";
import { A2AAdapter, type A2ACallOptions } from "./a2a-adapter.js";
import {
  A2ARoute,
  type A2AApp,
  type A2ACaller,
  type A2ACallerResolver,
  type MeshVerifier,
} from "./a2a-caller.js";
import {
  admitCaller,
  callerResolverOf,
  meshVerifierOf,
  writeRejection,
} from "./a2a-caller-gate.js";
import { cancelExchangeOf } from "./a2a-cancel.js";
import { dedupeOf } from "./a2a-dedupe.js";
import { answer, bodyTextOf, jsonOf, sendJson, type Exchange } from "./a2a-exchange.js";
import { admitMesh } from "./a2a-mesh-gate.js";
import { readRequestOf } from "./a2a-mesh-trust.js";
import { dedupeKeyOf, isSignedBody, trustedRequestOf, withRunReport } from "./a2a-trusted.js";
import { A2ARequestSchema } from "./types.js";

const ResumeSchema = z.object({ pauseId: z.string(), decision: z.unknown() });

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

/** `a2aHttpListener(app, { start, callerResolver, meshVerifier?, base? })` (#387, #398). */
export interface A2AHttpListenerOptions<TStart extends Class> {
  /** The workflow start `POST <base>/execute` runs. */
  readonly start: TStart;
  /**
   * Who calls (an `@Injectable` listed in the application's or a workflow's `providers`): the
   * listener takes its instance from the application's container and asks it on every request.
   */
  readonly callerResolver: Class<A2ACallerResolver<TStart>>;
  /**
   * Where peers' public keys come from besides `@Application({ mesh: { peers } })` (#398 PR 2): an
   * `@Injectable` listed in `providers`, asked before the caller resolver; omitted → the peers'.
   */
  readonly meshVerifier?: Class<MeshVerifier>;
  /** The routes' prefix (`"/a2a"` → `POST /a2a/execute`); default none. */
  readonly base?: string;
}

/** A route of the listener: which one, and its call into the adapter. */
interface ListenerRoute {
  readonly route: A2ARoute;
  readonly exchange: Exchange;
}

/** The listener's routes, by path. */
function routesOf(
  adapter: A2AAdapter,
  start: Class,
  base: string,
): ReadonlyMap<string, ListenerRoute> {
  const execute: Exchange = (body, onEvent, options) => {
    const parsed = A2ARequestSchema.safeParse(body);
    return parsed.success ? adapter.execute(start, parsed.data, onEvent, options) : undefined;
  };
  const resume: Exchange = (body, onEvent, options) => {
    const parsed = ResumeSchema.safeParse(body);
    return parsed.success ? adapter.resume(parsed.data, onEvent, options) : undefined;
  };
  return new Map([
    [`${base}/execute`, { route: A2ARoute.Execute, exchange: execute }],
    [`${base}/resume`, { route: A2ARoute.Resume, exchange: resume }],
    [`${base}/cancel`, { route: A2ARoute.Cancel, exchange: cancelExchangeOf(adapter) }],
  ]);
}

/** What serving one request needs: the app, its start, resolver and verifier. */
interface Listener<TStart extends Class> {
  readonly app: A2AApp;
  readonly start: TStart;
  readonly resolver: A2ACallerResolver<TStart>;
  readonly verifier: MeshVerifier | undefined;
}

/** A refused envelope: `401 { code, error }`, its body discarded. */
function refuse(res: ServerResponse, req: IncomingMessage, code: MeshRefusalCode): void {
  writeRejection(res, HTTP_UNAUTHORIZED, { code, error: MESH_REFUSAL_TEXT[code] });
  req.resume();
}

/** Serves one request of a route: envelope, caller, chain, body, dedupe, then the run. */
async function serve<TStart extends Class>(
  listener: Listener<TStart>,
  found: ListenerRoute,
  exchange: { readonly req: IncomingMessage; readonly res: ServerResponse },
): Promise<void> {
  const { req, res } = exchange;
  const { app } = listener;
  const read = await readRequestOf(app, listener.verifier, found.route, req);
  if ("refusal" in read) {
    refuse(res, req, read.refusal);
    return;
  }
  const gate = await admitCaller(listener.resolver, read.request, res);
  if (!gate.isAdmitted) return;
  const { peer, ...caller }: A2ACaller<TStart> = gate.caller;
  const mesh = admitMesh(app, listener.start, read.request, { res, peer });
  if (!mesh.isAdmitted) return;
  // the caller's values are the start's (the options tie the resolver to it): the app checks them
  await run(listener, found, exchange, {
    options: withInboundMesh(caller as A2ACallOptions, mesh.inbound),
    inbound: mesh.inbound,
    envelope: read.request.envelope,
  });
}

/** What an admitted request runs with: its options, its chain and the envelope it carried. */
interface Admitted {
  readonly options: A2ACallOptions;
  readonly inbound: InboundMesh | undefined;
  readonly envelope: MeshEnvelope | undefined;
}

/** Runs an admitted request: its body checked against a trusted envelope, deduplicated, answered. */
async function run<TStart extends Class>(
  listener: Listener<TStart>,
  found: ListenerRoute,
  exchange: { readonly req: IncomingMessage; readonly res: ServerResponse },
  admitted: Admitted,
): Promise<void> {
  const { req, res } = exchange;
  const { app } = listener;
  const text = await bodyTextOf(req);
  const tenantId = admitted.options.tenant?.tenantId ?? DEFAULT_TENANT_ID;
  const trusted = trustedRequestOf(admitted.inbound, admitted.envelope, tenantId);
  if (!isSignedBody(trusted, text)) {
    refuse(res, req, MeshRefusalCode.BodyMismatch);
    return;
  }
  const now = meshSettingsOf(app)?.clock.now() ?? new Date(0);
  const key = found.route === A2ARoute.Execute ? dedupeKeyOf(trusted) : undefined;
  const dedupe = await dedupeOf(app, key, exchange, now);
  if (dedupe.isAnswered) return;
  const settle = (result: Parameters<typeof withRunReport>[2]) =>
    Promise.resolve(withRunReport(app, trusted, result));
  const result = await answer(req, res, {
    exchange: found.exchange,
    options: admitted.options,
    body: jsonOf(text),
    settle,
  });
  await dedupe.keep(result);
}

/**
 * Serves an application's workflow over HTTP (#387), for
 * `http.createServer(a2aHttpListener(app, { start, callerResolver, base }))`:
 * `POST <base>/execute` `{ input, threadId? }`, `POST <base>/resume` `{ pauseId, decision }` and
 * `POST <base>/cancel` `{ threadId }` (#398 PR 2). Every request's mesh envelope is read first — a
 * signed one of a known issuer verified, a bad one a `401` (`mesh.signature-invalid`,
 * `mesh.envelope-expired`) — then its caller is resolved, by the `callerResolver` the application's
 * container created (not listed → this call throws), before its body is read or a header written:
 * a refused one is a real `401` / `403` (a resolver that throws: `500`), and nothing runs. An
 * admitted one runs for its tenant, owner and execution values — unless its call chain comes back
 * to this start or is too long: `409`, nothing runs (`a2a-mesh-gate.ts`). A trusted one (the
 * resolver's `peer` is the envelope's `signedBy`) must carry the body it signed (`401`
 * `mesh.body-mismatch`), is deduplicated by its idempotency key and runs on its caller's budget,
 * deadline and origin. The reply is the `A2AExecutionResponse` as JSON, or — with `Accept:
 * text/event-stream` — progress events followed by one `finish` event carrying it. A caller that
 * disconnects cancels its run.
 */
export function a2aHttpListener<TStart extends Class>(
  app: A2AApp,
  options: A2AHttpListenerOptions<TStart>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const resolver = callerResolverOf(app, options.callerResolver);
  const verifier =
    options.meshVerifier === undefined ? undefined : meshVerifierOf(app, options.meshVerifier);
  const listener: Listener<TStart> = { app, start: options.start, resolver, verifier };
  const routes = routesOf(new A2AAdapter(app), options.start, options.base ?? "");
  return (req, res) => {
    const found = req.method === "POST" ? routes.get(req.url ?? "") : undefined;
    if (found === undefined) {
      sendJson(res, HTTP_NOT_FOUND, { error: `no A2A route ${req.method ?? ""} ${req.url ?? ""}` });
      return;
    }
    serve(listener, found, { req, res }).catch(() => res.destroy());
  };
}
