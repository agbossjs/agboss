import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Class } from "../components/injection.js";
import { A2AAdapter, type A2ACallOptions } from "./a2a-adapter.js";
import {
  A2ARoute,
  type A2AApp,
  type A2ACaller,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "./a2a-caller.js";
import { admitCaller, callerResolverOf } from "./a2a-caller-gate.js";
import { admitMesh, requestEnvelopeOf } from "./a2a-mesh-gate.js";
import { withInboundMesh } from "../mesh/inbound-mesh.js";
import { A2ARequestSchema, type A2AEvent, type A2AExecutionResponse } from "./types.js";

const ResumeSchema = z.object({ pauseId: z.string(), decision: z.unknown() });

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

/** `a2aHttpListener(app, { start, callerResolver, base? })` (#387). */
export interface A2AHttpListenerOptions<TStart extends Class> {
  /** The workflow start `POST <base>/execute` runs. */
  readonly start: TStart;
  /**
   * Who calls (an `@Injectable` listed in the application's or a workflow's `providers`): the
   * listener takes its instance from the application's container and asks it on every request.
   */
  readonly callerResolver: Class<A2ACallerResolver<TStart>>;
  /** The routes' prefix (`"/a2a"` → `POST /a2a/execute`); default none. */
  readonly base?: string;
}

/** One request's call into the adapter, for its caller; `undefined` when the body is invalid. */
type Exchange = (
  body: unknown,
  onEvent: ((event: A2AEvent) => void) | undefined,
  options: A2ACallOptions,
) => Promise<A2AExecutionResponse> | undefined;

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const sseLine = (event: A2AEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** Runs one exchange: JSON in, then JSON out — or server-sent events when the caller accepts them. */
async function answer<TStart extends Class>(
  req: IncomingMessage,
  res: ServerResponse,
  exchange: Exchange,
  caller: A2ACaller<TStart>,
): Promise<void> {
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort(new Error("the caller disconnected"));
  });
  const streaming = (req.headers.accept ?? "").includes("text/event-stream");
  const onEvent = streaming ? (event: A2AEvent) => res.write(sseLine(event)) : undefined;
  if (streaming) res.writeHead(HTTP_OK, { "content-type": "text/event-stream" });
  const body = await bodyOf(req).catch(() => null);
  // the caller's values are the start's (the options tie the resolver to it): the app checks them
  const pending = exchange(body, onEvent, {
    ...(caller as A2ACallOptions),
    signal: aborted.signal,
  });
  if (pending === undefined) {
    if (streaming) res.end();
    else sendJson(res, HTTP_BAD_REQUEST, { error: "invalid A2A request" });
    return;
  }
  const result = await pending;
  if (streaming) res.end(sseLine({ type: "finish", payload: { result } }));
  else sendJson(res, HTTP_OK, result);
}

/** What the caller resolver reads of a request: its route, the raw request, its envelope (#398). */
function callerRequestOf(route: A2ARoute, req: IncomingMessage): A2ACallerRequest {
  const envelope = requestEnvelopeOf(req);
  return envelope === undefined ? { route, http: req } : { route, http: req, envelope };
}

/** The listener's two routes, by path. */
function routesOf(
  adapter: A2AAdapter,
  start: Class,
  base: string,
): ReadonlyMap<string, { readonly route: A2ARoute; readonly exchange: Exchange }> {
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
  ]);
}

/**
 * Serves an application's workflow over HTTP (#387), for
 * `http.createServer(a2aHttpListener(app, { start, callerResolver, base }))`:
 * `POST <base>/execute` `{ input, threadId? }` and `POST <base>/resume` `{ pauseId, decision }`.
 * Every request's caller is resolved first — by the `callerResolver` the application's container
 * created (not listed → this call throws) — before its body is read or a header written: a refused
 * one is a real `401` / `403` (a resolver that throws: `500`), and nothing runs. An admitted one runs
 * for its tenant, owner and execution values — unless its mesh envelope's call chain comes back to
 * this start or is too long (#398): `409`, nothing runs (`a2a-mesh-gate.ts`). The reply is the `A2AExecutionResponse` as JSON, or —
 * with `Accept: text/event-stream` — progress events followed by one `finish` event carrying it. A
 * caller that disconnects cancels its run.
 */
export function a2aHttpListener<TStart extends Class>(
  app: A2AApp,
  options: A2AHttpListenerOptions<TStart>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const resolver = callerResolverOf(app, options.callerResolver);
  const routes = routesOf(new A2AAdapter(app), options.start, options.base ?? "");
  return (req, res) => {
    const found = req.method === "POST" ? routes.get(req.url ?? "") : undefined;
    if (found === undefined) {
      sendJson(res, HTTP_NOT_FOUND, { error: `no A2A route ${req.method ?? ""} ${req.url ?? ""}` });
      return;
    }
    const request = callerRequestOf(found.route, req);
    admitCaller(resolver, request, res)
      .then((gate) => {
        if (!gate.isAdmitted) return undefined;
        const mesh = admitMesh(app, options.start, request, res);
        if (!mesh.isAdmitted) return undefined;
        return answer(req, res, found.exchange, withInboundMesh(gate.caller, mesh.inbound));
      })
      .catch(() => res.destroy());
  };
}
