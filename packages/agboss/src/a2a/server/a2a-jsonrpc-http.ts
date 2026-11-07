import type { IncomingMessage, ServerResponse } from "node:http";
import { Extensions } from "@a2a-js/sdk";
import { VersionNotSupportedError } from "@a2a-js/sdk/errors";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import type { Class } from "../../components/injection.js";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import type { Bytes } from "../../units/index.js";
import type { A2ACaller, A2ACallerResolver } from "../a2a-caller.js";
import { admitCaller } from "../a2a-caller-gate.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2A_VERSION, AGENT_CARD_PATH, type ServedAgentCard } from "./a2a-card.js";
import {
  bodyWithin,
  errorAnswerOf,
  sendCard,
  sendEvents,
  sendJson,
  wireSafeAnswer,
  type BindingLog,
} from "./a2a-http-io.js";
import { admittedRequestOf, type AdmittedRequest } from "./a2a-admitted.js";
import { admittedMeshOf, requestMeshOf, type A2ARequestMesh } from "./a2a-mesh-admission.js";
import { callerState } from "./a2a-server-parts.js";

/**
 * The JSON-RPC 2.0 binding on `node:http` (#808, spec §9, design §4.1.1–4.1.2): `GET
 * <base>/.well-known/agent-card.json` serves the card; `POST <base>` takes one JSON-RPC request —
 * its body read up to `maxBodySize` (over it: `413`), its `A2A-Version` checked (none means 0.3:
 * `-32009`), its method and task read, its mesh envelope checked (#810: `401 mesh.*`, nothing run —
 * `a2a-mesh-admission.ts`), then the caller resolver asked with them (a refusal is a real `401` /
 * `403`, nothing run), then the SDK's `JsonRpcTransportHandler` over our handler —
 * one JSON answer, or server-sent events for the streaming methods. A connection that closes ends
 * what the request waits for or streams, never the task.
 */

const HTTP_NOT_FOUND = 404;

const VERSION_HEADER = "a2a-version";
const EXTENSIONS_HEADER = "a2a-extensions";
const TRACEPARENT_HEADER = "traceparent";
/** What an empty or missing `A2A-Version` means (spec §3.6). */
const LEGACY_VERSION = "0.3";

/** What the binding serves with. */
export interface A2AHttpBinding {
  readonly card: ServedAgentCard;
  readonly handler: A2ARequestHandler;
  readonly resolver: A2ACallerResolver<Class>;
  /** The application's mesh settings: its name (the audience it accepts), its peers' keys. */
  readonly mesh: MeshSettings;
  readonly base: string;
  readonly maxBodySize: Bytes;
  readonly log: BindingLog;
}

/** A body that is no JSON: a fixed `-32700`, never the parser's words about it. */
const NOT_JSON = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32700, message: "the request body is not JSON" },
};

/** `-32009` with a fixed text: never the header's value back. */
const versionNotSupported = (): Error =>
  new VersionNotSupportedError({
    message: `the A2A version is not served: this agent serves ${A2A_VERSION}`,
    metadata: { code: "a2a.version-unsupported" },
  });

/** Whether the card declares the requested version for JSON-RPC (the SDK's own check). */
function isServedVersion(version: string, binding: A2AHttpBinding): boolean {
  try {
    validateVersion(version, binding.card.card, "JSONRPC");
    return true;
  } catch {
    return false; // its message names the caller's header: answered with a fixed one instead
  }
}

/** The request's JSON; `undefined` once answered (`413`, `-32700`) or its caller hung up. */
async function bodyJsonOf(req: IncomingMessage, res: ServerResponse, max: Bytes): Promise<unknown> {
  const text = await bodyWithin(req, res, max);
  if (text === undefined) return undefined;
  const body = jsonOf(text);
  if (body === undefined) sendJson(res, NOT_JSON);
  return body;
}

/** The JSON of a body; `undefined` when it is none (the transport answers the parse error). */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/** The requested A2A version: none, or empty, means 0.3 (spec §3.6). */
const versionOf = (req: IncomingMessage): string => {
  const asked = headerOf(req, VERSION_HEADER) ?? "";
  return asked === "" ? LEGACY_VERSION : asked;
};

/** The answer's headers: the extensions the call activated (echoed, spec §4.6). */
function extensionHeadersOf(context: ServerCallContext): Record<string, string> {
  const activated = context.activatedExtensions ?? [];
  return activated.length === 0 ? {} : { [EXTENSIONS_HEADER]: activated.join(", ") };
}

/** The extensions a call activates when it asks for them: both of ours (echoed, spec §4.6). */
const SERVED_EXTENSIONS = [A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION] as const;

/** The call's context: its version, extensions, and the admitted caller with the request's end. */
function contextOf(
  req: IncomingMessage,
  closed: AbortSignal,
  caller: A2ACaller<Class>,
  admitted: AdmittedRequest,
  mesh: A2ARequestMesh,
) {
  const requestedExtensions = Extensions.parseServiceParameter(headerOf(req, EXTENSIONS_HEADER));
  const context = new ServerCallContext({
    requestedVersion: versionOf(req),
    requestedExtensions,
    state: callerState(caller, closed, admitted, mesh),
  });
  for (const uri of SERVED_EXTENSIONS)
    if (requestedExtensions.includes(uri)) context.addActivatedExtension(uri);
  return context;
}

/** Serves one JSON-RPC request, as described above. */
async function serveRpc(
  binding: A2AHttpBinding,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // the request's end, from its first byte on: what it waits for stops when its caller hangs up
  const closed = new AbortController();
  res.once("close", () => {
    closed.abort();
  });
  const body = await bodyJsonOf(req, res, binding.maxBodySize);
  if (body === undefined) return;
  const text = JSON.stringify(body);
  const id = fieldOf(body, "id");
  const { log } = binding;
  const transport = new JsonRpcTransportHandler(binding.handler);
  const requestedVersion = versionOf(req);
  if (!isServedVersion(requestedVersion, binding)) {
    sendJson(res, errorAnswerOf(id, versionNotSupported(), log));
    return;
  }
  const admitted = admittedRequestOf(body);
  if (admitted === undefined) {
    // no operation of a caller: an invalid request, an unknown method, push or extended card
    const parsed =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : text;
    const answer = await transport.handle(parsed, new ServerCallContext({ requestedVersion }));
    sendJson(res, wireSafeAnswer(answer, log));
    return;
  }
  await serveAdmitted(binding, { req, res, closed, body, admitted, transport });
}

/** One request of a caller's operation, once its version and its operation are read. */
interface AdmittedRpc {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly closed: AbortController;
  readonly body: unknown;
  readonly admitted: AdmittedRequest;
  readonly transport: JsonRpcTransportHandler;
}

/** Its envelope checked, its caller resolved, then the transport's answer (JSON or events). */
async function serveAdmitted(binding: A2AHttpBinding, rpc: AdmittedRpc): Promise<void> {
  const { req, res, closed, body, admitted } = rpc;
  const { log } = binding;
  // the envelope before the resolver and before anything runs (design §4.1.2 step 3)
  const verdict = admittedMeshOf(binding.mesh, admitted.operation, body, res);
  if (verdict === undefined) return;
  const asked = {
    operation: admitted.operation,
    ...(admitted.taskId === "" ? {} : { taskId: admitted.taskId }),
  };
  const gate = await admitCaller(binding.resolver, { ...asked, http: req }, res, log);
  if (!gate.isAdmitted) return;
  if (res.destroyed) closed.abort();
  const mesh = requestMeshOf(verdict, gate.caller.peer, headerOf(req, TRACEPARENT_HEADER));
  const context = contextOf(req, closed.signal, gate.caller, admitted, mesh);
  const answer = await rpc.transport.handle(body as Record<string, unknown>, context);
  const headers = extensionHeadersOf(context);
  const id = fieldOf(body, "id");
  if (isAsyncIterable(answer)) await sendEvents(res, answer, { id, log, headers });
  else sendJson(res, wireSafeAnswer(answer, log), headers);
}

/** Serves one request of the binding. */
export async function serveA2AHttp(
  binding: A2AHttpBinding,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://listener").pathname;
  if (req.method === "GET" && path === `${binding.base}${AGENT_CARD_PATH}`) {
    sendCard(req, res, binding.card);
    return;
  }
  if (req.method === "POST" && path === (binding.base === "" ? "/" : binding.base)) {
    await serveRpc(binding, req, res);
    return;
  }
  res.writeHead(HTTP_NOT_FOUND, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "a2a.not-found", error: "no such A2A route" }));
}
