import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { admitMeshHttp } from "../mesh/mesh-http-admission.js";
import { MESH_HTTP_HEADER } from "../mesh/mesh-http.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT } from "../mesh/mesh-verification.js";
import type { McpSessionOptions } from "./mcp-tool-registry.js";

/**
 * The mesh's gate of every HTTP request to an MCP endpoint (#1320): what `a2aHttpListener` does for an
 * A2A one. Before anything of the request is read as MCP, its `X-AGBoss-Mesh` header is verified against
 * this very request (method, path, body), admitted once (`jti`) and checked against the peer's
 * `allowEndpoints`; a `Strict` mesh admits nothing unsigned. A refusal is answered here — `401` / `403` /
 * `503` with a code and its fixed text — and nothing of the request runs. An application with no mesh
 * has no peers: its requests are the host's to judge (the session it passes).
 */

/** What the gate lets through: the session the host gave, with the verified peer's identity laid over it. */
export interface McpHttpAdmission {
  readonly session: McpSessionOptions;
}

const headerOf = (req: IncomingMessage): string | undefined => {
  const value = req.headers[MESH_HTTP_HEADER.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value;
};

/** Checks one HTTP request to `endpoint`; `undefined` once refused (the answer is written). */
export async function admitMcpHttp(
  app: object,
  endpoint: Class,
  request: { readonly req: IncomingMessage; readonly res: ServerResponse; readonly body: string },
  session: McpSessionOptions,
): Promise<McpHttpAdmission | undefined> {
  const settings = meshSettingsOf(app);
  if (settings === undefined) return { session };
  const { req, res } = request;
  const decision = await admitMeshHttp(
    settings,
    {
      header: headerOf(req),
      method: req.method ?? "POST",
      path: req.url ?? "/",
      body: request.body,
    },
    endpoint,
  );
  if (decision.kind === "refused") {
    res
      .writeHead(decision.status, { "content-type": "application/json" })
      .end(JSON.stringify({ code: decision.code, error: MESH_REFUSAL_TEXT[decision.code] }));
    return undefined;
  }
  if (decision.kind === "external") return { session };
  // a verified peer: its identity is the mesh's — the host's session cannot name another peer or owner
  const tenant = decision.tenantId === undefined ? {} : { tenant: { tenantId: decision.tenantId } };
  return { session: { ...session, ownerId: decision.ownerId, peer: decision.peer, ...tenant } };
}
