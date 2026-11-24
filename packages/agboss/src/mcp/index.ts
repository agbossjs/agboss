/**
 * `@agboss/core/mcp` — MCP both ways: `@McpServer` for the MCP servers an application calls (a tool lists one in its `deps`),
 * and `@McpExpose` + `createMcpService` to serve a workflow as an MCP server. Loads the MCP SDK.
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
export { McpExpose, type McpExposeOptions } from "./mcp-expose.decorator.js";
export {
  McpService,
  createMcpService,
  type McpServiceOptions,
  type McpSession,
} from "./mcp-service.js";
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
