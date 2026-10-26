/**
 * `@agboss/core/mcp` — MCP both ways: `@McpServer` / `@McpTool` for the MCP servers a workflow uses,
 * and `@McpExpose` + `createMcpService` to serve a workflow as an MCP server. Loads the MCP SDK.
 */
import "../polyfills/symbol-metadata.js";

export { McpServer, McpTool } from "../components/decorators.js";
export {
  McpServerClient,
  type ServerTool,
  type ServerTools,
  type ToolsOf,
} from "../components/mcp-client.js";
export { McpExpose, type McpExposeOptions } from "./mcp-expose.decorator.js";
export { McpService, createMcpService, type McpSession } from "./mcp-service.js";
export type { McpSessionOptions } from "./mcp-tool-registry.js";
