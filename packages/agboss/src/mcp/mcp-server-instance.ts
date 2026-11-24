import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { MeshInboundMode } from "../mesh/mesh.decorator.js";
import type { McpEndpointOptions } from "./mcp-endpoint.decorator.js";
import { callIdOf, mcpServerOptionsOf } from "./mcp-service-helpers.js";
import { collectTools, type McpSessionOptions } from "./mcp-tool-registry.js";
import { dedupedMcpCall } from "./mcp-dedupe.js";
import { admitMcpCall } from "./mcp-mesh-gate.js";

/**
 * One MCP server for one connection (#1319): `tools/list` and `tools/call` of an `@McpEndpoint`'s
 * `tools`, every call run with the connection's `session` (its caller's owner, tenant and context
 * values — the transport's word, never the call's arguments).
 */

/**
 * The `@McpEndpoint` options of `endpoint`, once it may be served: it is one, and a `Strict` mesh
 * lists it in `@Application({ exposes })` (an endpoint it does not list has no gate and is not served).
 */
export function servedEndpointOf(app: App, endpoint: Class): McpEndpointOptions {
  const options = mcpServerOptionsOf(endpoint);
  if (!options) {
    throw new ConfigError.Environment({
      message: `[mcp.not-an-endpoint] ${endpoint.name} is not an @McpEndpoint`,
    });
  }
  const mesh = meshSettingsOf(app);
  if (mesh?.inboundMode === MeshInboundMode.Strict && !mesh.exposes.includes(endpoint)) {
    throw new ConfigError.Environment({
      message: `[application.expose-unlisted] ${endpoint.name} is not in @Application({ exposes }): under a Strict @Mesh an endpoint is served only through the mesh's gate`,
    });
  }
  return options;
}

/** The MCP server of `options` for one connection of `session`. */
export function mcpServerOf(
  app: App,
  options: McpEndpointOptions,
  session: McpSessionOptions,
): McpServer {
  const mcp = new McpServer(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );
  const { tools, handlers } = collectTools(app, options.tools, session);

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  mcp.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const { name, arguments: args, _meta } = request.params;
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`Tool not found: ${name}`);
    }
    // the caller's mesh envelope (#398): a loop or a chain too long is refused before it runs
    const call = { tool: name, meta: _meta, args, peer: session.peer };
    const admission = admitMcpCall(app, call);
    if (!admission.isAdmitted) return admission.refusal;
    const callId = callIdOf(_meta);
    const run = () =>
      handler({
        args,
        signal: extra.signal,
        ...(callId === undefined ? {} : { callId }),
        ...(admission.inbound === undefined ? {} : { mesh: admission.inbound }),
        ...(admission.bodyHash === undefined ? {} : { bodyHash: admission.bodyHash }),
      });
    // a trusted call with a callId runs once (#398 PR 2b): a repeat gets the kept result
    const tenantId = session.tenant?.tenantId;
    return dedupedMcpCall(app, { peer: admission.peer, callId, tenantId }, run);
  });

  return mcp;
}
