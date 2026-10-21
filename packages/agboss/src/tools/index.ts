/**
 * Public API of the tools module. Everything outside src/tools imports from here only
 * (lint-enforced); tools never import graph, agents, prompts or routers.
 */
import type { connectMcpServers as connectNow } from "./mcp/connect.js";

export {
  DEFAULT_TOOL_TIMEOUT,
  defineTool,
  InvalidToolNameError,
  ToolTimeoutError,
  type ToolDefinition,
} from "./define-tool.js";

export { renderToolResult, toolDefinitionOf } from "./langchain.js";
export type { AnyTool, Tool, ToolCallContext, ToolOutput } from "./types.js";
export { schemaDifferences } from "./mcp/compat.js";
export type { Env, McpConnections, TransportFactory } from "./mcp/connect.js";
export { McpContractError, McpUnavailableError } from "./mcp/errors.js";
export {
  isMcpFacade,
  mcpResultValue,
  mcpServer,
  type McpCaller,
  type McpFacade,
  type McpFacadeDefinition,
  type McpServerHandle,
  type McpToolRef,
} from "./mcp/facade.js";

/**
 * Connects the MCP servers a workflow uses (see `./mcp/connect.ts`). The MCP SDK is loaded on the
 * first call, never when `agboss` is imported (#195).
 */
export async function connectMcpServers(
  ...args: Parameters<typeof connectNow>
): ReturnType<typeof connectNow> {
  const { connectMcpServers: connect } = await import("./mcp/connect.js");
  return connect(...args);
}
