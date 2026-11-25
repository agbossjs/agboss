/**
 * `@agboss/core/mcp` — MCP both ways: `@McpServer` for the MCP servers an application calls (a tool lists one in its `deps`),
 * and `@McpEndpoint` + `connectMcp` / `connectMcpStdio` / `mcpHttpListener` to serve a workflow as an MCP server. Loads the MCP SDK.
 */
import "../polyfills/symbol-metadata.js";

export { McpServer, type McpServerOptions } from "../components/decorators.js";
export {
  McpServerClient,
  type ServerTool,
  type McpCallArguments,
  type McpCallOptions,
  type ServerTools,
  type ToolsOf,
} from "../components/mcp-client.js";
export { McpEndpoint, type McpEndpointOptions } from "./mcp-endpoint.decorator.js";
export {
  connectMcp,
  connectMcpStdio,
  type McpConnection,
  type McpConnectionSession,
  type McpConnectOptions,
  type McpStdioOptions,
  type McpWireMessage,
  type McpWireTransport,
} from "./mcp-connect.js";
export { mcpHttpListener, type McpHttpListenerOptions } from "./mcp-http-listener.js";
export type { McpSessionOptions } from "./mcp-tool-registry.js";
export { type ArgumentsOf, type ResultOf } from "../components/mcp-client.js";
export {
  McpTransport,
  type McpHttpConfig,
  type McpServerCommon,
  type McpServerConfig,
  type McpServerTarget,
  type McpStdioConfig,
} from "../config/mcp-server-config.js";
export { McpError, McpErrorKind } from "../core/error-families/remote-errors.js";
