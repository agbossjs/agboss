import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listenerAuthenticatorOf,
  notifyHost,
  writeRejection,
  admitCaller,
  type CallerGateOutcome,
} from "../a2a/a2a-caller-gate.js";
import { bodyWithin } from "../a2a/server/a2a-http-io.js";
import type { AnyTenantApp, App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import type { HttpCaller } from "../http/http-auth.js";
import { Clock } from "../infrastructure/clock.js";
import { frameworkLogOf, Logger } from "../infrastructure/logger.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { kilobytes, type Bytes } from "../units/index.js";
import { headerOf, jsonOf, pathOf } from "./mcp-http-io.js";
import { originFn } from "./mcp-public-url.js";
import { inSession, isSameCaller } from "./mcp-session-identity.js";
import { admitMcpHttp } from "./mcp-http-gate.js";
import type { McpEndpointOptions } from "./mcp-endpoint.decorator.js";
import { mcpServerOf, servedEndpointOf } from "./mcp-server-instance.js";
import type { McpCaller } from "./mcp-service-helpers.js";

/**
 * `mcpHttpListener` (#1319): an `@McpEndpoint` over MCP's Streamable HTTP, symmetric with
 * `a2aHttpListener`. Every request is admitted on its own, before anything of it is read as MCP: a
 * signed mesh peer (`X-AGBoss-Mesh`, verified against this very request, admitted once, allowed this
 * endpoint) or a caller the `@HttpAuthenticator` judges. A session belongs to the identity that
 * opened it: any other caller's request naming its id is answered "no such session", and a peer's
 * session takes only that peer's signed messages.
 */

/** `mcpHttpListener(app, { endpoint, publicUrl, authenticator?, base?, maxBodySize?, onError? })`. */
export interface McpHttpListenerOptions {
  /** The `@McpEndpoint` served, listed in `@Application({ endpoints })`. */
  readonly endpoint: Class;
  /**
   * Who calls (an `@HttpAuthenticator` listed in `@Application({ services })`). Required, unless
   * `allowAnonymous` is set or only signed mesh peers call (`@Mesh({ inboundMode: Strict })` with a
   * peer that propagates its tenant): else the listener is not made (`ConfigError`,
   * `[http.authenticator-required-for-tenant-context]`). A tenant it names no owner for is bound,
   * session by session, to `(tenant, Mcp-Session-Id)`: its owner is `mcp-session:<id>`.
   */
  readonly authenticator?: Class;
  /**
   * Serves callers no authenticator vouches for (default `false`): the one explicit opt-in, for an
   * application with no `tenantContext` of its own (with one, or beside an `authenticator`, the
   * listener is not made: `ConfigError`). An anonymous caller's identity is `anonymous:<Mcp-Session-Id>`,
   * the session's own random id issued at `initialize` — never its connection, which a proxy pools
   * and which a client's `POST` and `GET` do not share.
   */
  readonly allowAnonymous?: boolean;
  /**
   * Where callers reach the listener, an absolute http(s) URL without the `base` — or a function that
   * says it when asked (a port known once it listens): a peer's signature must name its origin.
   * Required when the application has a `@Mesh` with peers (`[mcp.public-url-invalid]` otherwise).
   */
  readonly publicUrl?: string | (() => string);
  /** The path it serves (`"/mcp"`); default `"/"`. */
  readonly base?: string;
  /** The largest request body read: over it `413`, nothing run. By default `kilobytes(1024)`. */
  readonly maxBodySize?: Bytes;
  /** Told of an error the listener or the authenticator hit, with the request: its text never goes on the wire. */
  readonly onError?: (error: unknown, req: IncomingMessage) => void;
}

const SESSION_HEADER = "mcp-session-id";
const UNAVAILABLE = { code: "mcp.listener-failed", error: "the MCP server is not available" };
const NO_SESSION = { code: "mcp.session-not-found", error: "there is no such session" };
const NOT_JSON = { code: "mcp.body-not-json", error: "the request body is not JSON" };

interface OpenSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: McpCaller;
}

const UNAUTHENTICATED = {
  code: "mcp.caller-unauthenticated",
  error: "the request is not from a signed mesh peer",
};

const TENANT_MISSING = {
  code: "mcp.caller-anonymous",
  error: "the caller names no tenant: this application serves only a caller with one",
};

/** What a request's verified identity is passed on as to the server: the SDK's `req.auth`, read back per message. */
const verified = new WeakMap<AuthInfo, McpCaller>();

/** Marks `req` as carrying `identity`, for the server that handles it. */
function carrying(req: IncomingMessage, identity: McpCaller): void {
  const info: AuthInfo = { token: "", clientId: "", scopes: [] };
  verified.set(info, identity);
  (req as IncomingMessage & { auth?: AuthInfo }).auth = info;
}

/** The identity of the message being served: the one its own request was verified as; none is refused. */
function messageIdentity(extra: { readonly authInfo?: AuthInfo }): McpCaller {
  const identity = extra.authInfo === undefined ? undefined : verified.get(extra.authInfo);
  if (identity === undefined) throw new Error("an MCP message arrived with no verified identity");
  return identity;
}

/** The identity a host's `@HttpAuthenticator` gave, as a connection's session. */
const sessionOf = (caller: HttpCaller): McpCaller => ({
  ownerId: caller.ownerId,
  tenant: caller.tenant,
  execution: caller.execution,
  peer: caller.peer,
});

/** What a listener serves with. */
interface Listening {
  readonly app: AnyTenantApp;
  readonly options: McpHttpListenerOptions;
  readonly served: McpEndpointOptions;
  readonly authenticator: ReturnType<typeof listenerAuthenticatorOf>;
  /** The origin peers sign for; none without a `@Mesh` that has peers. */
  readonly origin: () => string | undefined;
  readonly base: string;
  readonly maxBody: Bytes;
  readonly log: ReturnType<typeof frameworkLogOf>;
  readonly sessions: Map<string, OpenSession>;
}

/**
 * The authenticator's caller. With none, only a listener made with `allowAnonymous` serves a caller
 * that is no peer: an anonymous one; any other is `401`.
 */
async function judgedCallerOf(
  l: Listening,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<CallerGateOutcome> {
  if (l.authenticator !== undefined)
    return admitCaller(
      l.authenticator.instance,
      { http: req, operation: req.method ?? "POST" },
      res,
      l.log,
      l.options.onError,
    );
  if (l.options.allowAnonymous === true) return { isAdmitted: true, caller: {} };
  writeRejection(res, 401, UNAUTHENTICATED);
  return { isAdmitted: false };
}

/** The caller of this request: a verified peer, the authenticator's caller, or `undefined` once answered. */
async function identityOf(
  l: Listening,
  request: { req: IncomingMessage; res: ServerResponse; raw: string },
): Promise<McpCaller | undefined> {
  const { req, res, raw } = request;
  // the signature before everything it claims; each request is judged on its own
  const admitted = await admitMcpHttp(
    l.app,
    l.options.endpoint,
    { req, res, body: raw },
    {},
    l.origin(),
  );
  if (admitted === undefined) return undefined;
  if (admitted.session.peer !== undefined) return admitted.session;
  const gate = await judgedCallerOf(l, req, res);
  if (!gate.isAdmitted) return undefined;
  const identity = sessionOf(gate.caller);
  if (identity.tenant === undefined && meshSettingsOf(l.app)?.isBaseTenantContext === false) {
    // an application with a tenantContext serves no caller without a tenant (fail closed)
    writeRejection(res, 403, TENANT_MISSING);
    return undefined;
  }
  return identity;
}

/** A new session of `caller`: its own server, kept from the SDK's `initialize` until it closes. */
function opened(l: Listening, caller: McpCaller): OpenSession {
  const id = randomUUID();
  const identity = inSession(caller, id);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    onsessioninitialized: () => {
      l.sessions.set(id, { transport, identity });
    },
  });
  transport.onclose = () => {
    l.sessions.delete(id);
  };
  void mcpServerOf(l.app, l.served, messageIdentity).connect(transport);
  return { transport, identity };
}

/** The transport of this request and who it runs as: the session's, or a new one for the request that opens it. */
function transportOf(
  l: Listening,
  request: { req: IncomingMessage; res: ServerResponse },
  caller: McpCaller,
): OpenSession | undefined {
  const { req, res } = request;
  const id = headerOf(req, SESSION_HEADER);
  if (id === undefined && req.method === "POST") return opened(l, caller);
  const open = id === undefined ? undefined : l.sessions.get(id);
  const asked = id === undefined ? caller : inSession(caller, id);
  if (open === undefined || !isSameCaller(asked, open.identity)) {
    // a stranger holding an id is told what any other id is told
    writeRejection(res, 404, NO_SESSION);
    return undefined;
  }
  return { transport: open.transport, identity: open.identity };
}

/** Serves one request. */
async function serve(l: Listening, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (pathOf(req) !== l.base) {
    writeRejection(res, 404, { code: "mcp.not-found", error: "there is nothing here" });
    return;
  }
  const raw = req.method === "POST" ? await bodyWithin(req, res, l.maxBody) : "";
  if (raw === undefined) return;
  const identity = await identityOf(l, { req, res, raw });
  if (identity === undefined) return;
  const body = raw === "" ? undefined : jsonOf(raw);
  if (raw !== "" && body === undefined) {
    writeRejection(res, 400, NOT_JSON);
    return;
  }
  const served = transportOf(l, { req, res }, identity);
  if (served === undefined) return;
  carrying(req, served.identity); // this message runs as the session's caller
  await served.transport.handleRequest(req, res, body);
}

/** `http.createServer(mcpHttpListener(app, { endpoint, authenticator?, publicUrl, base }))`. */
export function mcpHttpListener<TApp>(
  app: App<TApp>,
  options: McpHttpListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const listening: Listening = {
    app,
    options,
    served: servedEndpointOf(app, options.endpoint),
    authenticator: listenerAuthenticatorOf(app, options.authenticator, options.allowAnonymous),
    origin: originFn(app, options.publicUrl),
    base: options.base ?? "/",
    maxBody: options.maxBodySize ?? kilobytes(1024),
    log: frameworkLogOf(app.resolve(Logger), app.resolve(Clock)),
    sessions: new Map(),
  };
  return (req, res) => {
    serve(listening, req, res).catch((error: unknown) => {
      // a failure past the listener's own answers: logged by its class, never its text on the wire
      const name = error instanceof Error ? error.name : typeof error;
      listening.log.error(
        "mcp.listener-failed",
        `the MCP listener failed to serve a request: ${name}`,
      );
      notifyHost(options.onError, error, req);
      if (res.headersSent) res.destroy();
      else writeRejection(res, 503, UNAVAILABLE);
    });
  };
}
