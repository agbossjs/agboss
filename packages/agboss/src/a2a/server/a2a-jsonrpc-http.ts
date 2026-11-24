import type { IncomingMessage, ServerResponse } from "node:http";
import { VersionNotSupportedError } from "@a2a-js/sdk/errors";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import type { Bytes } from "../../units/index.js";
import type { HttpAuthenticatorHandler } from "../../http/http-authenticator.js";
import type { Class } from "../../components/injection.js";
import { admittedPeerOf, callerOfPeer, externalCallerOf, refuse } from "./a2a-peer-gate.js";
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
import { admittedMeshOf, requestMeshOf, tenantRefusalOf } from "./a2a-mesh-admission.js";
import {
  contextOf,
  extensionHeadersOf,
  fieldOf,
  headerOf,
  isAsyncIterable,
  versionOf,
} from "./a2a-rpc-context.js";

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

const TRACEPARENT_HEADER = "traceparent";

/** What the binding serves with. */
export interface A2AHttpBinding {
  readonly card: ServedAgentCard;
  readonly handler: A2ARequestHandler;
  /** Absent: only signed mesh peers call (`a2aHttpListener` checked it may be). */
  readonly authenticator?: HttpAuthenticatorHandler;
  /** The `@A2AExpose` it serves: what a peer's `allowEndpoints` is matched against. */
  readonly endpoint: Class;
  /** The origin the listener is reached at (`publicUrl`): a peer's signature must be made for it. */
  readonly origin: string;
  /** The host's own error hook (`a2aHttpListener({ onError })`). */
  readonly onError?: (error: unknown, req: IncomingMessage) => void;
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
async function bodyJsonOf(
  req: IncomingMessage,
  res: ServerResponse,
  max: Bytes,
): Promise<{ readonly body: unknown; readonly raw: string } | undefined> {
  const raw = await bodyWithin(req, res, max);
  if (raw === undefined) return undefined;
  const body = jsonOf(raw);
  if (body === undefined) sendJson(res, NOT_JSON);
  return body === undefined ? undefined : { body, raw };
}

/** The JSON of a body; `undefined` when it is none (the transport answers the parse error). */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
  const read = await bodyJsonOf(req, res, binding.maxBodySize);
  if (read === undefined) return;
  const { body, raw } = read;
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
  await serveAdmitted(binding, { req, res, closed, body, raw, admitted, transport });
}

/** One request of a caller's operation, once its version and its operation are read. */
interface AdmittedRpc {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly closed: AbortController;
  readonly body: unknown;
  /** The body as received: what the peer's `X-AGBoss-Mesh` signature binds. */
  readonly raw: string;
  readonly admitted: AdmittedRequest;
  readonly transport: JsonRpcTransportHandler;
}

/** Its mesh header and envelope checked, its caller authenticated, then the transport's answer. */
async function serveAdmitted(binding: A2AHttpBinding, rpc: AdmittedRpc): Promise<void> {
  const { req, res, closed, body, admitted } = rpc;
  const { log } = binding;
  // the signature before everything it claims, the envelope before the authenticator and before
  // anything runs (design §4.1.2 step 3)
  const request = {
    req,
    res,
    raw: rpc.raw,
    operation: admitted.operation,
    taskId: admitted.taskId,
  };
  const peer = await admittedPeerOf({ ...binding, log }, request);
  if (peer === undefined) return;
  const verdict = admittedMeshOf(binding.mesh, admitted.operation, body, res);
  if (verdict === undefined) return;
  const mismatch = peer.kind === "peer" ? tenantRefusalOf(peer, verdict.envelope) : undefined;
  if (mismatch !== undefined) {
    refuse(res, mismatch);
    return;
  }
  const gate =
    peer.kind === "peer"
      ? { isAdmitted: true as const, caller: callerOfPeer(peer) }
      : await externalCallerOf({ ...binding, log }, request);
  if (!gate.isAdmitted) return;
  if (res.destroyed) closed.abort();
  const mesh = requestMeshOf(verdict, gate.caller.peer, headerOf(req, TRACEPARENT_HEADER));
  const context = contextOf(req, closed.signal, gate.caller, admitted, mesh);
  const answer = await rpc.transport.handle(body as Record<string, unknown>, context);
  const headers = extensionHeadersOf(context);
  const id = fieldOf(body, "id");
  if (isAsyncIterable(answer))
    await sendEvents(res, answer, { id, log, clock: binding.mesh.clock, headers });
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
